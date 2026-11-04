/**
 * TypeScript mirror of `schemas/trace.schema.json`.
 * JSON Schema is the source of truth. Update both together and bump CONTRACT_VERSION.
 */

export type TraceStatus = "running" | "completed" | "error" | "cancelled";

export type FaultCategory =
  | "Plan"
  | "ToolUse"
  | "Context"
  | "Reasoning"
  | "Execution"
  | "Verification"
  | "Security";

export type TraceStepType = "message" | "tool_call" | "tool_result" | "system";

export type StepRole = "user" | "assistant" | "tool" | "system";

export type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface TraceStep {
  step_id: string;
  index: number;
  type: TraceStepType;
  timestamp: string;
  role: StepRole;
  content: string;
  tool_name?: string | null;
  tool_call_id?: string | null;
  tool_input?: JsonValue;
  tool_output?: JsonValue;
  tool_error?: string | null;
  latency_ms?: number | null;
  token_usage?: TokenUsage | null;
  cost_usd?: number | null;
}

export interface VerifierCheckResult {
  check_id: string;
  passed: boolean;
  message: string | null;
}

/** Sole success authority for a trace. Written only by the deterministic verifier. */
export interface VerifierOutcome {
  passed: boolean;
  checks: VerifierCheckResult[];
  mock_state_snapshot: Record<string, JsonValue>;
}

export interface TraceOutcome {
  verifier: VerifierOutcome;
}

export interface TraceTotals {
  latency_ms: number;
  tokens: TokenUsage;
  cost_usd: number;
}

export interface FaultLabel {
  category: FaultCategory;
  step_id?: string | null;
  detail?: string;
}

/**
 * Ground truth for a chaos run.
 * Written only by the injector. Grok must not set `injected`, `labels`, or `attacker`.
 */
export interface Fault {
  injected: boolean;
  labels: FaultLabel[];
  attacker: string | null;
}

export interface DiagnosisEvidence {
  step_id: string;
  note: string;
}

export interface ProposedFix {
  fix_id: string;
  summary: string;
}

/**
 * Grok's only writable region on a Trace.
 * `category` is a hypothesis. Ground truth remains `fault.labels`.
 */
export interface Diagnosis {
  category: FaultCategory;
  cause: string;
  step_id: string | null;
  confidence: number;
  evidence: DiagnosisEvidence[];
  proposed_fixes: ProposedFix[];
}

export interface Trace {
  trace_id: string;
  agent_id: string;
  run_id: string;
  task_id: string;
  started_at: string;
  ended_at: string | null;
  /** Execution lifecycle. Task success is `outcome.verifier.passed`. */
  status: TraceStatus;
  steps: TraceStep[];
  outcome: TraceOutcome;
  totals: TraceTotals;
  fault: Fault;
  /** Null until Grok writes a diagnosis. */
  diagnosis: Diagnosis | null;
}
