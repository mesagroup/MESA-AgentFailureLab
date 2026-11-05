import { FIX_KINDS, type Agent, type AgentTask, type FixKind, type Run, type RunPhase, type RunStatus } from "@mesa/shared";
import type { RunParams } from "./api";

/** Mirrors `POST /attacker/jury-case` body. Kept here so node tests can load this module. */
export interface JuryLaunchBody {
  note: string;
  task_id: string;
  permissions: string[];
  include_baseline: boolean;
  fix_kinds?: string[];
  parent_run_id?: string;
  prompt_override?: string;
}

const JURY_NOTE_MAX = 8000;

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
 * Launcher phases. `jury` is UI-only — Run.phase in @mesa/shared stays
 * baseline | injected | after_fix. Security launches POST /attacker/jury-case.
 */
export const LAUNCH_PHASES = ["baseline", "injected", "jury", "after_fix"] as const;
export type LaunchPhase = (typeof LAUNCH_PHASES)[number];

/** Plain-English labels for the Launch phase picker (internal IDs unchanged). */
export const LAUNCH_PHASE_COPY: Record<LaunchPhase, { label: string; subtitle: string }> = {
  baseline: { label: "Clean run", subtitle: "Measure normal behavior" },
  injected: { label: "Inject fault", subtitle: "Replay a baseline with a fault" },
  jury: { label: "Security attack", subtitle: "Attack note + permission check" },
  after_fix: { label: "Verify fix", subtitle: "Replay after the owner fixed the agent" },
};

/** Short labels for stored RunPhase badges (no jury — launch mode only). */
export const RUN_PHASE_LABELS: Record<RunPhase, string> = {
  baseline: "Clean run",
  injected: "Inject fault",
  after_fix: "Verify fix",
};

export function runPhaseLabel(phase: RunPhase | string): string {
  return RUN_PHASE_LABELS[phase as RunPhase] ?? phase;
}

export function isRunLaunchPhase(phase: LaunchPhase): phase is RunPhase {
  return phase === "baseline" || phase === "injected" || phase === "after_fix";
}

export function phaseNeedsReferenceRun(phase: LaunchPhase): boolean {
  return phase === "injected" || phase === "after_fix" || phase === "jury";
}

export const JURY_LAUNCH_COPY = {
  helper:
    "Security launch mode (not a stored run phase): attack note plus a permission check on the agent.",
  referenceLabel: "Run to attack",
  referenceAttack: "Run to attack",
  referenceReplay: "Run to replay",
  noteLabel: "Attack note",
  permissionsLabel: "Allowed permissions",
  includeBaselineLabel: "Also run a clean control (same task and grant, no note)",
  replayHint:
    "Replay stores the attack as Verify fix with the earlier run and a permission check.",
  attackHint:
    "The attacker appends the note to this task. The stored run is tagged as a security case.",
  emptyReferences: "No completed runs for this agent. Launch a clean run first.",
  loadingCase: "Loading the security case…",
  promptLabel: "Prompt for this launch",
  promptHelper: "Starts from the reference task. Edit before launch.",
  promptReset: "Reset to task prompt",
} as const;

export const PROMPT_LAUNCH_COPY = {
  label: "Prompt for this launch",
  helperInjected: "Starts from the baseline task. Edit or add instructions before launch.",
  helperJury: "Starts from the reference task. Edit before launch.",
  reset: "Reset to task prompt",
  historyLabel: "Prompt history",
  historyHint: "Previous launches for this task. Click a row to load it into the editor. Launching adds a new row.",
  taskLine: "Original task prompt",
} as const;

/** Launch-sheet copy for the injected-phase info tooltip (#179). */
export const INJECTED_LAUNCH_COPY = {
  buttonLabel: "About inject fault",
  tooltip:
    "These tests re-run your previous completed baseline runs. The platform automatically injects a malicious prompt. Injection is an automatic platform service, transparent to the agent's end user — not a manual ad-hoc attack.",
} as const;

/** Stored Run.phase produced by this launch sheet phase. */
export function storedPhaseForLaunch(
  phase: LaunchPhase,
  juryMode: "attack" | "replay" | null,
): RunPhase | null {
  if (phase === "injected" || phase === "after_fix") return phase;
  if (phase === "jury") return juryMode === "replay" ? "after_fix" : "injected";
  return null;
}

export interface PromptHistoryEntry {
  run_id: string;
  phase: RunPhase;
  prompt: string;
  started_at?: string;
}

/**
 * Previous effective prompts for agent+task+stored phase.
 * `runs` is newest-first (`GET /runs`); returned rows are oldest first (newest last).
 */
export function promptHistoryEntries(
  runs: readonly Run[],
  agentId: string,
  taskId: string,
  storedPhase: RunPhase,
  startedAtByRunId?: Readonly<Record<string, string>>,
): PromptHistoryEntry[] {
  const matched = runs.filter(
    (run) =>
      run.agent_id === agentId &&
      run.task_id === taskId &&
      run.phase === storedPhase &&
      typeof run.prompt === "string" &&
      run.prompt.length > 0,
  );
  return [...matched].reverse().map((run) => ({
    run_id: run.run_id,
    phase: run.phase,
    prompt: run.prompt as string,
    ...(startedAtByRunId?.[run.run_id] ? { started_at: startedAtByRunId[run.run_id] } : {}),
  }));
}

/** Terminal runs of this agent (picker for the jury/security phase). */
export function juryReferenceRunsForAgent(runs: readonly Run[], agentId: string): Run[] {
  return runs.filter((run) => run.agent_id === agentId && TERMINAL.has(run.status));
}

export function juryLaunchMode(run: Pick<Run, "phase"> | null | undefined): "attack" | "replay" | null {
  if (!run) return null;
  if (run.phase === "baseline") return "attack";
  if (run.phase === "injected" || run.phase === "after_fix") return "replay";
  return null;
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
      run.prompt ?? "",
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

export function buildJuryLaunchParams(input: {
  note: string;
  referenceRun: Pick<Run, "run_id" | "phase" | "task_id"> | null;
  permissions: readonly string[];
  includeBaseline: boolean;
  fixKinds: readonly string[];
  maxChars?: number;
  promptOverride?: string | null;
}): { ok: true; body: JuryLaunchBody } | { ok: false; message: string } {
  const reference = input.referenceRun;
  if (!reference) {
    return { ok: false, message: "Select a completed run to attack or replay." };
  }
  const mode = juryLaunchMode(reference);
  if (!mode) {
    return { ok: false, message: "Select a completed baseline, injected, or after_fix run." };
  }
  const note = input.note.trim();
  const maxChars = input.maxChars ?? JURY_NOTE_MAX;
  if (note.length === 0) return { ok: false, message: "The attack note cannot be empty." };
  if (note.length > maxChars) return { ok: false, message: `The note can be at most ${maxChars} characters.` };
  if (reference.task_id.trim().length === 0) return { ok: false, message: "Choose a task." };

  const body: JuryLaunchBody = {
    note,
    task_id: reference.task_id.trim(),
    permissions: [...input.permissions],
    include_baseline: mode === "replay" ? false : input.includeBaseline,
  };

  if (mode === "replay") {
    const kinds = input.fixKinds.map((kind) => kind.trim()).filter((kind) => kind.length > 0);
    if (kinds.length === 0 || !kinds.includes("permission_guard")) {
      return {
        ok: false,
        message: "Select Permission check (and any other fixes) to replay the security case.",
      };
    }
    body.fix_kinds = kinds;
    body.parent_run_id = reference.run_id;
  }

  const promptOverride = input.promptOverride?.trim();
  if (promptOverride) body.prompt_override = promptOverride;

  return { ok: true, body };
}

export type LaunchRequest =
  | { ok: true; kind: "run"; params: RunParams }
  | { ok: true; kind: "jury"; body: JuryLaunchBody }
  | { ok: false; message: string };

/** Dispatch RunSheet submit: POST /runs for Run phases, POST /attacker/jury-case for jury. */
export function buildLaunchRequest(input: {
  agentId: string;
  phase: LaunchPhase;
  taskIds: readonly string[];
  parentRunId: string | null;
  fixKinds: readonly FixKind[];
  promptOverride?: string | null;
  jury?: {
    note: string;
    permissions: readonly string[];
    includeBaseline: boolean;
    referenceRun: Pick<Run, "run_id" | "phase" | "task_id"> | null;
    maxChars?: number;
  };
}): LaunchRequest {
  if (input.phase === "jury") {
    if (!input.jury) return { ok: false, message: "Security launch is missing the attack note form." };
    const built = buildJuryLaunchParams({
      note: input.jury.note,
      referenceRun: input.jury.referenceRun,
      permissions: input.jury.permissions,
      includeBaseline: input.jury.includeBaseline,
      fixKinds: input.fixKinds,
      maxChars: input.jury.maxChars,
      promptOverride: input.promptOverride,
    });
    if (!built.ok) return built;
    return { ok: true, kind: "jury", body: built.body };
  }
  const built = buildLaunchParams({
    agentId: input.agentId,
    phase: input.phase,
    taskIds: input.taskIds,
    parentRunId: input.parentRunId,
    fixKinds: input.fixKinds,
    promptOverride: input.promptOverride,
  });
  if (!built.ok) return built;
  return { ok: true, kind: "run", params: built.params };
}

export function jurySheetReady(input: {
  note: string;
  referenceRun: Pick<Run, "run_id" | "phase" | "task_id"> | null;
  permissions: readonly string[];
  includeBaseline: boolean;
  fixKinds: readonly string[];
  maxChars?: number;
}): boolean {
  return buildJuryLaunchParams(input).ok;
}

export { FIX_KINDS };
