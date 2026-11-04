/**
 * Hand-written types for the JSON Schemas in `../schemas`.
 * The schema files are the source of truth. If these types disagree with a
 * schema, change the types (and the drift test) to match the schema.
 */

export const FAULT_CATEGORIES = [
  "Plan",
  "ToolUse",
  "Context",
  "Reasoning",
  "Execution",
  "Verification",
  "Security",
] as const;

export type FaultCategory = (typeof FAULT_CATEGORIES)[number];

/** Applied on a Run. A Diagnosis may only propose these values. */
export const FIX_KINDS = [
  "controlled_retry",
  "pre_response_check",
  "permission_guard",
] as const;

export type FixKind = (typeof FIX_KINDS)[number];

export const TRACE_STATUSES = ["completed", "failed", "timeout", "error"] as const;

export type TraceStatus = (typeof TRACE_STATUSES)[number];

export const STEP_TYPES = ["message", "tool_call", "tool_result", "system"] as const;

export type StepType = (typeof STEP_TYPES)[number];

export const STEP_ROLES = ["user", "assistant", "tool", "system"] as const;

export type StepRole = (typeof STEP_ROLES)[number];

export const RUN_PHASES = ["baseline", "injected", "after_fix"] as const;

export type RunPhase = (typeof RUN_PHASES)[number];

export const RUN_STATUSES = ["queued", "running", "passed", "failed", "error"] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const AGENT_INSTANCE_KINDS = ["reference", "external"] as const;

export type AgentInstanceKind = (typeof AGENT_INSTANCE_KINDS)[number];

export const TRACE_STORE_KINDS = ["inline", "path", "url"] as const;

export type TraceStoreKind = (typeof TRACE_STORE_KINDS)[number];

export interface TokenUsage {
  input: number;
  output: number;
}

export interface TraceStep {
  step_id: string;
  index: number;
  type: StepType;
  timestamp: string;
  role: StepRole;
  content?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_output?: unknown;
  latency_ms: number;
  token_usage: TokenUsage;
  cost_usd: number;
}

export interface VerifierCheck {
  name: string;
  passed: boolean;
  detail: string;
}

/**
 * Pass/fail truth for one trace.
 * `success` must equal `verifier.passed`. Only the deterministic verifier writes
 * this object. Grok does not.
 */
export interface TraceOutcome {
  success: boolean;
  verifier: {
    passed: boolean;
    checks: VerifierCheck[];
    mock_state_snapshot: Record<string, unknown>;
  };
  agent_claimed_success: boolean;
}

export interface TraceTotals {
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

export interface FaultLabel {
  category: FaultCategory;
  step_id: string;
  code: string;
}

export interface TraceFault {
  injected: boolean;
  labels: FaultLabel[];
  attacker: {
    used: boolean;
    payload_id: string | null;
  };
}

/**
 * Grok diagnosis attached to a trace after the fact.
 * `step_id` is the culprit step. `proposed_fixes` are suggestions; the harness
 * records the ones it actually applies on the Run.
 */
export interface Diagnosis {
  category: FaultCategory;
  cause: string;
  step_id: string;
  confidence: number;
  evidence: string[];
  proposed_fixes: FixKind[];
}

/**
 * One observed attempt. Does not carry Run.phase, InjectionPlan, or FixKind.
 */
export interface Trace {
  trace_id: string;
  agent_id: string;
  run_id: string;
  task_id: string;
  started_at: string;
  ended_at: string;
  status: TraceStatus;
  steps: TraceStep[];
  outcome: TraceOutcome;
  totals: TraceTotals;
  fault: TraceFault;
  diagnosis: Diagnosis | null;
}

export interface AgentToolDoc {
  name: string;
  description: string;
}

export interface AgentTaskCheck {
  name: string;
  description: string;
  params?: Record<string, unknown>;
}

export interface AgentTask {
  task_id: string;
  title: string;
  prompt: string;
  success_test: {
    type: "verifier_checks";
    checks: AgentTaskCheck[];
  };
}

export interface Agent {
  agent_id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  instance: {
    kind: AgentInstanceKind;
    base_url: string;
    runtime: string;
  };
  test_instance: {
    base_url: string;
    runtime: string;
  };
  traces: {
    store: TraceStoreKind;
    path_or_url: string;
  };
  docs: {
    prompt_summary: string;
    tools: AgentToolDoc[];
    constraints: string[];
    config_notes: string;
  };
  tasks: AgentTask[];
}

/**
 * Injector intent. Lives on a Run. The labels that result from it are what
 * the injector writes onto `Trace.fault`.
 */
export interface InjectionPlan {
  fault: string;
  target: string;
  at_step?: number;
  ground_truth: {
    category: FaultCategory;
    code: string;
    step_id?: string;
  };
}

/**
 * Harness record. `phase`, `injection_plan`, and `fix_kinds` are Run fields.
 * They are not part of Trace.
 */
export interface Run {
  run_id: string;
  agent_id: string;
  task_id: string;
  parent_run_id?: string | null;
  phase: RunPhase;
  status: RunStatus;
  trace_ids: string[];
  injection_plan: InjectionPlan | null;
  fix_kinds: FixKind[];
  error_message?: string;
  duration_ms?: number;
}
