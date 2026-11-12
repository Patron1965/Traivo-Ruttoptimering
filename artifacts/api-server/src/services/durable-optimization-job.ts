import { loadRuntimeState, saveRuntimeState } from "./planning-runtime-store";
import { logger } from "../lib/logger";

const JOB_TTL_MS = 24 * 60 * 60_000;
export const JOB_LEASE_MS = 120_000;
export interface DurableOptimizationJob {
  id: string;
  organizationId: string;
  status: "running" | "complete" | "error";
  createdAt: number;
  error: string | null;
  [key: string]: unknown;
}

export function interruptedJob<T extends DurableOptimizationJob>(job: T, updatedAt: Date, now = Date.now()): T {
  if (job.status !== "running" || now - updatedAt.getTime() <= JOB_LEASE_MS) return job;
  // Never rerun a job automatically: route persistence or a dispatch may
  // already have committed just before the process stopped.
  return { ...job, status: "error", error: "Planeringen avbröts eller tappade kontakten med servern. Ladda om och kontrollera sparade rutter innan du startar en ny planering." };
}

export async function readOptimizationJob<T extends DurableOptimizationJob>(organizationId: string, id: string): Promise<T | null> {
  const stored = await loadRuntimeState<T>(organizationId, "optimization-job", id);
  return stored ? interruptedJob(stored.value, stored.updatedAt) : null;
}

export async function startOptimizationJob<T extends DurableOptimizationJob>(job: T) {
  // Serialize snapshots, including heartbeat writes, so a late running-state
  // update cannot overwrite a complete/error state.
  let pending = Promise.resolve();
  const flush = () => {
    pending = pending.catch(() => {}).then(() =>
      saveRuntimeState(job.organizationId, "optimization-job", job.id, job, JOB_TTL_MS));
    return pending;
  };
  await flush();
  const heartbeat = setInterval(() => {
    void flush().catch(() => logger.error(
      { event: "optimization_job_heartbeat_failed", jobId: job.id },
      "Could not persist optimization heartbeat",
    ));
  }, 10_000);
  heartbeat.unref();
  return {
    async finish() {
      clearInterval(heartbeat);
      try {
        await flush();
      } catch {
        // Route writes may already have committed. Never crash the process or
        // replay the operation because the terminal status write failed.
        // The persisted heartbeat will age into explicit recovery guidance.
        logger.error(
          { event: "optimization_job_terminal_state_failed", jobId: job.id, status: job.status },
          "Could not persist final optimization status; check saved routes before retrying",
        );
      }
    },
  };
}
