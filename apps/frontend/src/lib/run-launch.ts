import { FIX_KINDS, type Agent, type AgentTask, type FixKind, type Run, type RunPhase, type RunStatus } from "@mesa/shared";
import type { RunParams } from "./api";

const TERMINAL: ReadonlySet<RunStatus> = new Set(["passed", "failed", "error"]);

/**
 * Baseline runs of this agent that finished (picker for injected / after_fix).
 * Keeps `runs` order (harness `GET /runs` is newest first).
 */
export function baselineRunsForAgent(runs: readonly Run[], agentId: string): Run[] {
  return runs.filter(
    (run) =>
      run.agent_id === agentId &&
      run.phase === "baseline" &&
      TERMINAL.has(run.status),
  );
}

export function phaseNeedsBaselineParent(phase: RunPhase): boolean {
  return phase === "injected" || phase === "after_fix";
}

/** Resolve the agent task for a run (title / prompt labels). */
export function taskForRun(agent: Agent | null | undefined, run: Pick<Run, "task_id">): AgentTask | undefined {
  return agent?.tasks.find((task) => task.task_id === run.task_id);
}

export function taskTitleForRun(agent: Agent | null | undefined, run: Pick<Run, "task_id">): string {
  return taskForRun(agent, run)?.title ?? run.task_id;
}

/** Case-insensitive filter over run id, task id, title, prompt, status. */
export function filterRunsByQuery(
  runs: readonly Run[],
  agent: Agent | null | undefined,
  query: string,
): Run[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...runs];
  return runs.filter((run) => {
    const task = taskForRun(agent, run);
    const haystack = [
      run.run_id,
      run.task_id,
      run.status,
      run.phase,
      task?.title ?? "",
      task?.prompt ?? "",
      run.error_message ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

export function formatRunDuration(ms: number | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Build `POST /runs` params for the Agents launch sheet.
 * Injected / after_fix take a baseline `parent_run_id` (task comes from the parent).
 * Optional `promptOverride` replaces the stored task prompt for that run only.
 */
export function buildLaunchParams(input: {
  agentId: string;
  phase: RunPhase;
  taskIds: readonly string[];
  parentRunId: string | null;
  fixKinds: readonly FixKind[];
  promptOverride?: string | null;
}): { ok: true; params: RunParams } | { ok: false; message: string } {
  const promptOverride = input.promptOverride?.trim() || undefined;

  if (input.phase === "baseline") {
    if (input.taskIds.length === 0) {
      return { ok: false, message: "Select at least one task." };
    }
    return {
      ok: true,
      params: {
        agent_id: input.agentId,
        phase: "baseline",
        task_ids: [...input.taskIds],
        ...(promptOverride ? { prompt_override: promptOverride } : {}),
      },
    };
  }

  const parent = input.parentRunId?.trim() ?? "";
  if (!parent) {
    return {
      ok: false,
      message:
        input.phase === "injected"
          ? "Select a completed baseline run to inject."
          : "Select a baseline run to replay as after_fix.",
    };
  }

  if (input.phase === "injected") {
    return {
      ok: true,
      params: {
        agent_id: input.agentId,
        phase: "injected",
        parent_run_id: parent,
        ...(promptOverride ? { prompt_override: promptOverride } : {}),
      },
    };
  }

  if (input.fixKinds.length === 0) {
    return {
      ok: false,
      message: "Select at least one fix kind for after_fix.",
    };
  }

  return {
    ok: true,
    params: {
      agent_id: input.agentId,
      phase: "after_fix",
      parent_run_id: parent,
      fix_kinds: [...input.fixKinds],
      ...(promptOverride ? { prompt_override: promptOverride } : {}),
    },
  };
}

export function toggleLaunchFixKind(selected: readonly FixKind[], kind: FixKind): FixKind[] {
  return selected.includes(kind) ? selected.filter((item) => item !== kind) : [...selected, kind];
}

export { FIX_KINDS };
