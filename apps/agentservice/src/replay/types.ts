import type { FaultCategory, FixKind } from "@mesa/shared";
import type { ApplicatorProbes } from "../fixes/probes.js";
import type { LabTaskId } from "../fixes/domain.js";

/**
 * One arm scored by the backend verifier.
 * `passed` is copied from `trace.outcome.verifier.passed`. This package does not write it.
 * `fix_kinds_on_agent_run_request` is true when the harness put a non-empty
 * `fix_kinds` on the shared `AgentRunRequest` passed to `callAgent`.
 * Baseline and injected runs omit it.
 */
export interface AttemptScore {
  readonly source: "backend-harness";
  readonly run_id: string;
  readonly parent_run_id: string | null;
  readonly passed: boolean;
  readonly failed_checks: readonly string[];
  readonly agent_claimed_success: boolean;
  readonly latency_ms: number;
  readonly step_count: number;
  readonly tokens_in: number;
  readonly tokens_out: number;
  readonly cost_usd: number;
  readonly duration_ms: number;
  readonly fix_kinds_on_run: readonly FixKind[];
  readonly policy_applied_in_call_agent: boolean;
  readonly fix_kinds_on_agent_run_request: boolean;
}

export type ReplayPhase = "baseline" | "injected" | "after_fix";

export interface ReplayPortRequest {
  readonly taskId: LabTaskId;
  readonly phase: ReplayPhase;
  readonly fixes: readonly FixKind[];
  readonly parentRunId?: string;
}

export interface ReplayPort {
  run(input: ReplayPortRequest): Promise<AttemptScore>;
}

export type FixSource = "specified" | "diagnosis" | "adr-002-category-map" | "none";

export type ScoredArm =
  | { readonly status: "ran"; readonly attempt: AttemptScore }
  | { readonly status: "skipped"; readonly reason: string };

export interface TaskReplayRow {
  readonly task_id: LabTaskId;
  readonly preset_category: FaultCategory;
  readonly fix_kinds: readonly FixKind[];
  readonly fix_source: FixSource;
  readonly baseline: AttemptScore;
  readonly baseline_all_fixes: AttemptScore;
  readonly injected_before: AttemptScore;
  readonly injected_after: ScoredArm;
  /** True only when the after arm passes and the injected arm does not. */
  readonly fix_verified: boolean | null;
  /** True when the no-fault run passed and the same task with all three fixes failed. */
  readonly regression: boolean;
}

export interface OwnerRequest {
  readonly owner: "@diamanti-sg" | "@ercoleMesa";
  readonly area: string;
  readonly request: string;
}

export interface ReplayReport {
  readonly schema_version: 1;
  readonly label: "Harness verifier scores for T1–T5. The agent service does not write outcome.verifier or fault.*.";
  readonly decision: "fix_verified is true only when injected_after passes the backend verifier and injected_before does not, and regression is false.";
  readonly runs_per_arm: 1;
  readonly spread: "not applicable: verifier.passed is a deterministic function of the shop seed and the preset.";
  readonly timing: {
    readonly latency_ms_equals_step_count: boolean;
    readonly limiter: string;
    readonly tokens_and_cost: string;
    readonly duration_ms: string;
  };
  readonly tasks: readonly TaskReplayRow[];
  readonly probes: ApplicatorProbes;
  readonly blocked: readonly string[];
  readonly requests: readonly OwnerRequest[];
}
