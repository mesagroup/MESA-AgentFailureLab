import { randomUUID } from "node:crypto";
import { WORLD_BUSY_ERROR, WorldBusyError } from "./world-gate.js";

export interface AcceptedJob {
  job_id: string;
  poll: string;
  deadline_ms: number;
}

interface Settled<T> {
  ok: true;
  result: T;
}

interface Failed {
  ok: false;
  error: unknown;
}

interface JobRecord {
  id: string;
  deadlineMs: number;
  startedAt: number;
  state: "running" | "done" | "error";
  body?: unknown;
  error?: string;
  message?: string;
}

const jobs = new Map<string, JobRecord>();
const JOB_TTL_MS = 30 * 60 * 1000;

/**
 * Start `start` and answer as soon as its world gate is held.
 * A failure before the gate (the world is busy, the request is invalid)
 * rejects here so the HTTP handler can still return that error.
 * Later failures stay on the job. The page polls them.
 */
export async function acceptWhenGated<T>(
  deadlineMs: number,
  start: (onAcquired: () => void) => Promise<T>,
): Promise<AcceptedJob> {
  evictOldJobs();
  let resolveGate: () => void = () => {};
  let gateEntered = false;
  const gated = new Promise<void>((resolve) => {
    resolveGate = () => {
      gateEntered = true;
      resolve();
    };
  });
  const settled: Promise<Settled<T> | Failed> = start(() => resolveGate()).then(
    (result) => ({ ok: true as const, result }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await Promise.race([
    gated,
    settled.then((value) => {
      if (!gateEntered && !value.ok) throw value.error;
    }),
  ]);
  const id = `job-${randomUUID()}`;
  const job: JobRecord = {
    id,
    deadlineMs,
    startedAt: Date.now(),
    state: "running",
  };
  jobs.set(id, job);
  void settled.then((value) => {
    if (job.state !== "running") return;
    if (value.ok) {
      job.state = "done";
      job.body = value.result;
      return;
    }
    job.state = "error";
    job.error = errorCode(value.error);
    job.message = errorMessage(value.error);
  });
  return { job_id: id, poll: `/agent-jobs/${id}`, deadline_ms: deadlineMs };
}

export function readAgentJob(id: string):
  | { status: "running"; job_id: string; deadline_ms: number }
  | { status: "done"; job_id: string; body: unknown }
  | { status: "error"; job_id: string; error: string; message: string }
  | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  if (job.state === "running" && Date.now() - job.startedAt > job.deadlineMs) {
    return {
      status: "error",
      job_id: job.id,
      error: "grok_timeout",
      message: "Grok run exceeded its time limit.",
    };
  }
  if (job.state === "done") return { status: "done", job_id: job.id, body: job.body };
  if (job.state === "error") {
    return {
      status: "error",
      job_id: job.id,
      error: job.error ?? "error",
      message: job.message ?? "Grok run failed.",
    };
  }
  return { status: "running", job_id: job.id, deadline_ms: job.deadlineMs };
}

function errorCode(error: unknown): string {
  if (error instanceof WorldBusyError) return WORLD_BUSY_ERROR;
  return "grok_run_failed";
}

function errorMessage(error: unknown): string {
  if (error instanceof WorldBusyError) return error.message;
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "Grok run failed.";
}

function evictOldJobs(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.startedAt > JOB_TTL_MS) jobs.delete(id);
  }
}
