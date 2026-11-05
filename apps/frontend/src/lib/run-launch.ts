import { FIX_KINDS, type FixKind, type Run, type RunPhase, type RunStatus } from "@mesa/shared";
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

/**
 * Build `POST /runs` params for the Agents launch sheet.
 * Injected / after_fix take a baseline `parent_run_id` (task comes from the parent).
 */
export function buildLaunchParams(input: {
  agentId: string;
  phase: RunPhase;
  taskIds: readonly string[];
  parentRunId: string | null;
  fixKinds: readonly FixKind[];
}): { ok: true; params: RunParams } | { ok: false; message: string } {
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
    },
  };
}

export function toggleLaunchFixKind(selected: readonly FixKind[], kind: FixKind): FixKind[] {
  return selected.includes(kind) ? selected.filter((item) => item !== kind) : [...selected, kind];
}

export { FIX_KINDS };
