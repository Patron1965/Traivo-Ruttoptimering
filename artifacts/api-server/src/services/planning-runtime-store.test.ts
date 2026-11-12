import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import { db, pool, organizationsTable } from "@workspace/db";
import { encodeRuntimeState, decodeRuntimeState, saveRuntimeState, loadRuntimeState, deleteRuntimeState, retainRuntimeState } from "./planning-runtime-store";
import { interruptedJob, JOB_LEASE_MS, startOptimizationJob, readOptimizationJob } from "./durable-optimization-job";

after(async () => { await pool.end(); });

test("executable proposals roundtrip Date, Map, Set and undefined without changing types", () => {
  const original = { date: new Date("2026-10-19T06:00:00Z"), evaluations: new Map([["v", { feasible: true }]]), ids: new Set(["a"]), absent: undefined };
  assert.deepEqual(decodeRuntimeState(encodeRuntimeState(original)), original);
});

test("running jobs expire into an explicit non-replaying recovery state", () => {
  const job = { id: randomUUID(), organizationId: randomUUID(), status: "running" as const, error: null, createdAt: 1 };
  assert.equal(interruptedJob(job, new Date(1000), 1000 + JOB_LEASE_MS).status, "running");
  const interrupted = interruptedJob(job, new Date(1000), 1001 + JOB_LEASE_MS);
  assert.equal(interrupted.status, "error");
  assert.match(interrupted.error!, /kontrollera sparade rutter/);
  assert.equal(job.status, "running");
});

test("persisted jobs/proposals are tenant-bound, survive reload, expire, and retain the best candidate atomically", async () => {
  const orgA = randomUUID(), orgB = randomUUID();
  await db.insert(organizationsTable).values([
    { id: orgA, name: "Synthetic runtime A", email: "runtime-a@example.test" },
    { id: orgB, name: "Synthetic runtime B", email: "runtime-b@example.test" },
  ]);
  try {
    const proposal = { date: new Date(), evaluations: new Map([["v", 1]]) };
    await saveRuntimeState(orgA, "whole-plan-proposal", "p:hash", proposal, 60_000);
    assert.deepEqual((await loadRuntimeState(orgA, "whole-plan-proposal", "p:hash"))?.value, proposal);
    assert.equal(await loadRuntimeState(orgB, "whole-plan-proposal", "p:hash"), null);
    assert.equal(await loadRuntimeState(orgA, "optimization-job", "p:hash"), null);
    await deleteRuntimeState(orgB, "whole-plan-proposal", "p:hash");
    assert.ok(await loadRuntimeState(orgA, "whole-plan-proposal", "p:hash"));
    await saveRuntimeState(orgA, "whole-plan-proposal", "expired", proposal, -1);
    assert.equal(await loadRuntimeState(orgA, "whole-plan-proposal", "expired"), null);
    await Promise.all([3, 1, 2].map(candidate =>
      retainRuntimeState(orgA, "best", "same", candidate, 60_000, Math.min)));
    assert.equal((await loadRuntimeState<number>(orgA, "best", "same"))?.value, 1);
    const job = { id: randomUUID(), organizationId: orgA, status: "running" as "running" | "complete" | "error", createdAt: Date.now(), error: null };
    const reporter = await startOptimizationJob(job);
    assert.equal((await readOptimizationJob(orgA, job.id))?.status, "running");
    assert.equal(await readOptimizationJob(orgB, job.id), null);
    job.status = "complete";
    await reporter.finish();
    assert.equal((await readOptimizationJob(orgA, job.id))?.status, "complete");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgA));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgB));
  }
});
