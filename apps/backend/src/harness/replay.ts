import type { Run, Trace } from "@mesa/shared";
import type { RunStore } from "../persistence/store.js";
import type { InjectionRequest, TaskRunResult } from "./runner.js";

export interface AfterFixParent {
  taskIds?: string[];
  injection?: InjectionRequest;
  parentRunId: string;
}

/** Paths FE uses to load the child replay and the parent (before) run. */
export interface RunResultLinks {
  run: string;
  trace: string | null;
  parent_run: string | null;
  parent_trace: string | null;
}

export interface LinkedTaskRunResult extends TaskRunResult {
  parent: { run: Run; trace: Trace | null } | null;
  links: RunResultLinks;
}

/**
 * Bind `POST /runs` to a stored parent when `parent_run_id` is set.
 *
 * - `after_fix`: parent may be baseline or injected. Omitted `task_ids` become
 *   the parent's task. Omitted `injection` copies the parent's `injection_plan`
 *   (null for a baseline parent). Send `injection: null` for a clean replay.
 * - `injected`: parent must be a baseline run of the same agent. Task comes from
 *   the parent; injection stays the request value (preset when omitted).
 * - `baseline`: `parent_run_id` is rejected.
 */
export async function resolveAfterFixParent(input: {
  store: RunStore;
  agentId: string;
  phase: string;
  taskIds?: string[];
  injection?: InjectionRequest;
  parentRunId?: string | null;
}): Promise<{ ok: true; value: AfterFixParent | null } | { ok: false; message: string }> {
  const parentRunId =
    input.parentRunId === undefined || input.parentRunId === null ? "" : input.parentRunId.trim();
  if (parentRunId.length === 0) {
    return { ok: true, value: null };
  }
  if (input.phase !== "after_fix" && input.phase !== "injected") {
    return {
      ok: false,
      message: "parent_run_id is only valid when phase is injected or after_fix.",
    };
  }
  const parent = await input.store.getRun(parentRunId);
  if (!parent) return { ok: false, message: `No run ${parentRunId}` };
  if (parent.agent_id !== input.agentId) {
    return {
      ok: false,
      message: `parent_run_id agent ${parent.agent_id} does not match agent_id ${input.agentId}.`,
    };
  }
  if (input.phase === "injected" && parent.phase !== "baseline") {
    return {
      ok: false,
      message: `injected parent_run_id must reference a baseline run (got phase ${parent.phase}).`,
    };
  }
  let taskIds = input.taskIds;
  if (taskIds === undefined) {
    taskIds = [parent.task_id];
  } else if (taskIds.length !== 1 || taskIds[0] !== parent.task_id) {
    return {
      ok: false,
      message: `task_ids must be omitted or [${parent.task_id}] to replay run ${parentRunId}.`,
    };
  }
  if (input.phase === "injected") {
    return { ok: true, value: { taskIds, injection: input.injection, parentRunId } };
  }
  const injection =
    input.injection === undefined
      ? parent.injection_plan
        ? structuredClone(parent.injection_plan)
        : null
      : input.injection;
  return { ok: true, value: { taskIds, injection, parentRunId } };
}

export async function withRunLinks(
  store: RunStore,
  results: readonly TaskRunResult[],
): Promise<LinkedTaskRunResult[]> {
  const linked: LinkedTaskRunResult[] = [];
  for (const result of results) {
    linked.push(await linkOne(store, result));
  }
  return linked;
}

async function linkOne(store: RunStore, result: TaskRunResult): Promise<LinkedTaskRunResult> {
  const parentId = result.run.parent_run_id;
  const parentRun =
    parentId !== undefined && parentId !== null && parentId.length > 0
      ? await store.getRun(parentId)
      : undefined;
  const parentTrace = parentRun ? await firstTrace(store, parentRun) : undefined;
  return {
    ...result,
    parent: parentRun ? { run: parentRun, trace: parentTrace ?? null } : null,
    links: {
      run: `/runs/${result.run.run_id}`,
      trace: result.trace ? `/traces/${result.trace.trace_id}` : null,
      parent_run: parentRun ? `/runs/${parentRun.run_id}` : null,
      parent_trace: parentTrace ? `/traces/${parentTrace.trace_id}` : null,
    },
  };
}

async function firstTrace(store: RunStore, run: Run): Promise<Trace | undefined> {
  const firstId = run.trace_ids[0];
  if (!firstId) return undefined;
  return store.getTrace(firstId);
}
