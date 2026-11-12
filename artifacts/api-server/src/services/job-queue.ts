import { randomUUID } from "node:crypto";

export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface Job<TPayload = unknown, TResult = unknown> {
  id: string;
  type: string;
  status: JobStatus;
  payload: TPayload;
  result?: TResult;
  error?: string;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  organizationId?: string | null;
}

type Handler<TPayload, TResult> = (payload: TPayload, job: Job<TPayload, TResult>) => Promise<TResult>;

const jobs = new Map<string, Job>();
const queue: string[] = [];
const handlers = new Map<string, Handler<unknown, unknown>>();
let processing = false;
const MAX_CONCURRENT = parseInt(process.env.JOB_QUEUE_CONCURRENCY || "2");
const RETRY_DELAY_MS = 2000;
const TTL_MS = 60 * 60 * 1000;

let activeWorkers = 0;

export function registerHandler<TPayload, TResult>(type: string, handler: Handler<TPayload, TResult>): void {
  handlers.set(type, handler as Handler<unknown, unknown>);
}

export function enqueue<TPayload>(
  type: string,
  payload: TPayload,
  opts: { organizationId?: string | null; maxAttempts?: number } = {},
): Job<TPayload> {
  const job: Job<TPayload> = {
    id: randomUUID(),
    type,
    status: "queued",
    payload,
    attempts: 0,
    maxAttempts: opts.maxAttempts ?? 3,
    createdAt: Date.now(),
    organizationId: opts.organizationId ?? null,
  };
  jobs.set(job.id, job as Job);
  queue.push(job.id);
  setImmediate(processNext);
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listJobs(filter: { organizationId?: string; status?: JobStatus; type?: string } = {}): Job[] {
  const result: Job[] = [];
  for (const job of jobs.values()) {
    if (filter.organizationId && job.organizationId !== filter.organizationId) continue;
    if (filter.status && job.status !== filter.status) continue;
    if (filter.type && job.type !== filter.type) continue;
    result.push(job);
  }
  return result.sort((a, b) => b.createdAt - a.createdAt);
}

async function processNext(): Promise<void> {
  if (activeWorkers >= MAX_CONCURRENT) return;
  if (queue.length === 0) return;

  const id = queue.shift()!;
  const job = jobs.get(id);
  if (!job) return;

  const handler = handlers.get(job.type);
  if (!handler) {
    job.status = "failed";
    job.error = `No handler for type "${job.type}"`;
    job.completedAt = Date.now();
    return;
  }

  activeWorkers++;
  job.status = "running";
  job.startedAt = Date.now();
  job.attempts++;

  try {
    const result = await handler(job.payload, job);
    job.status = "completed";
    job.result = result;
    job.completedAt = Date.now();
  } catch (err: unknown) {
    job.error = err instanceof Error ? err.message : String(err);
    if (job.attempts < job.maxAttempts) {
      job.status = "queued";
      console.warn(`[JOB] ${job.type} #${job.id} failed (attempt ${job.attempts}), retrying...`);
      setTimeout(() => {
        queue.push(job.id);
        processNext();
      }, RETRY_DELAY_MS * job.attempts);
    } else {
      job.status = "failed";
      job.completedAt = Date.now();
      console.error(`[JOB] ${job.type} #${job.id} failed permanently after ${job.attempts} attempts:`, job.error);
    }
  } finally {
    activeWorkers--;
    setImmediate(processNext);
  }
}

setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if ((job.status === "completed" || job.status === "failed") && job.completedAt && job.completedAt < cutoff) {
      jobs.delete(id);
    }
  }
}, 5 * 60 * 1000).unref?.();
