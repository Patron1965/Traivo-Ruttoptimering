import assert from "node:assert/strict";
import { test } from "node:test";
import { sortDistrictQueueCandidates, type DistrictQueueCandidate } from "./district-queue";

test("district queue serves tenants fairly across plans and keeps tenant plan FIFO", () => {
  const at=(minute:number)=>new Date(`2026-01-01T00:${String(minute).padStart(2,"0")}:00Z`);
  const queued:DistrictQueueCandidate[]=[
    {jobId:"a1",organizationId:"org-a",planId:"plan-a1",createdAt:at(1),lastStartedAt:at(10)},
    {jobId:"b1",organizationId:"org-b",planId:"plan-b1",createdAt:at(3),lastStartedAt:at(5)},
    {jobId:"a2",organizationId:"org-a",planId:"plan-a2",createdAt:at(2),lastStartedAt:at(10)},
    {jobId:"c1",organizationId:"org-c",planId:"plan-c1",createdAt:at(4),lastStartedAt:null},
  ];
  assert.deepEqual(sortDistrictQueueCandidates(queued).map(job=>job.jobId),["c1","b1","a1","a2"]);

  // After C is claimed it is no longer perpetually favored; the stored claim time
  // rotates it behind tenants whose previous starts are older.
  const next=queued.map(job=>job.jobId==="c1"?{...job,lastStartedAt:at(11)}:job);
  assert.deepEqual(sortDistrictQueueCandidates(next).map(job=>job.jobId),["b1","a1","a2","c1"]);
});