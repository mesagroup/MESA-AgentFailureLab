import type { Run, RunPhase, FixKind, Trace } from "@mesa/shared";

const BACKEND = (import.meta.env.VITE_BACKEND_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");

async function backendFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BACKEND}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

// --- Runs ---

export interface RunParams {
  phase: RunPhase;
  task_ids?: string[];
  fix_kinds?: FixKind[];
  parent_run_id?: string | null;
}

export async function listRuns(): Promise<Run[]> {
  const data = await backendFetch<{ runs: Run[] }>("/runs");
  return data.runs;
}

export async function getRun(id: string): Promise<Run> {
  return backendFetch<Run>(`/runs/${id}`);
}

export async function createRun(params: RunParams): Promise<Run[]> {
  const body: Record<string, unknown> = { phase: params.phase };
  if (params.task_ids?.length) body.task_ids = params.task_ids;
  if (params.fix_kinds?.length) body.fix_kinds = params.fix_kinds;
  if (params.parent_run_id !== undefined) body.parent_run_id = params.parent_run_id;
  const data = await backendFetch<{ results: Run[] }>("/runs", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data.results;
}

// --- Traces ---

export async function listTraces(): Promise<Trace[]> {
  const data = await backendFetch<{ traces: Trace[] }>("/traces");
  return data.traces;
}

export async function getTrace(id: string): Promise<Trace> {
  return backendFetch<Trace>(`/traces/${id}`);
}
