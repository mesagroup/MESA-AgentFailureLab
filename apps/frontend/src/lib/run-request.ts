import type { FixKind, InjectionPlan, Run, RunPhase } from "@mesa/shared";

/** `preset` uses each task's catalog preset. An object is one catalog fault. `null` injects nothing. */
export type RunInjection = "preset" | InjectionPlan | null;

export interface RunParams {
  agent_id: string;
  phase: RunPhase;
  task_ids?: string[];
  fix_kinds?: FixKind[];
  parent_run_id?: string | null;
  injection?: RunInjection;
}

export function runRequestBody(params: RunParams): Record<string, unknown> {
  const body: Record<string, unknown> = { agent_id: params.agent_id, phase: params.phase };
  if (params.task_ids?.length) body.task_ids = params.task_ids;
  if (params.fix_kinds?.length) body.fix_kinds = params.fix_kinds;
  if (params.parent_run_id !== undefined) body.parent_run_id = params.parent_run_id;
  if (params.injection !== undefined) body.injection = params.injection;
  return body;
}

/**
 * `POST /runs` returns `{ results: [{ run, trace }] }`.
 * Older callers sometimes described `results` as a bare run list. Accept both.
 */
export function runsFromCreateResponse(data: unknown): Run[] {
  if (!data || typeof data !== "object" || !("results" in data) || !Array.isArray(data.results)) {
    throw new Error("The run response did not include results.");
  }
  return data.results.map((entry) => {
    if (isRun(entry)) return entry;
    if (entry && typeof entry === "object" && "run" in entry && isRun(entry.run)) return entry.run;
    throw new Error("The run response did not include a run.");
  });
}

function isRun(value: unknown): value is Run {
  return Boolean(value && typeof value === "object" && "run_id" in value && "phase" in value && "status" in value);
}
