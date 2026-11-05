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

export function isFixKind(value: unknown): value is FixKind {
  return typeof value === "string" && (FIX_KINDS as readonly string[]).includes(value);
}

/**
 * ADR-002 MVP applicator for a diagnosis or fault category.
 * Plan, ToolUse, Context, and Reasoning have no MVP fix.
 * `diagnosis.proposed_fixes` and `Run.fix_kinds` use these same ids — there is
 * no second enum (not `fault_kinds`).
 */
export const ADR_FIX_BY_CATEGORY: Partial<Record<FaultCategory, FixKind>> = {
  Execution: "controlled_retry",
  Verification: "pre_response_check",
  Security: "permission_guard",
};

export function adrFixForCategory(category: FaultCategory): FixKind | undefined {
  return ADR_FIX_BY_CATEGORY[category];
}

export const TRACE_STATUSES = ["completed", "failed", "timeout", "error"] as const;

export type TraceStatus = (typeof TRACE_STATUSES)[number];

/**
 * Where a Trace was written.
 * Absent on documents saved before the field. A missing value is not a fifth source.
 */
export const TRACE_SOURCES = ["harness", "demo_seed", "otel_prod", "otel_test"] as const;

export type TraceSource = (typeof TRACE_SOURCES)[number];

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
  /**
   * Writer of this document. Omit on traces saved before the field.
   * `otel_prod` and `otel_test` are a telemetry pull. That pull does not invent
   * `outcome.verifier` or `fault.labels`.
   */
  source?: TraceSource;
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

/** One line the harness adds to the session cart before the agent runs. */
export interface AgentTaskCartLine {
  sku: string;
  qty: number;
}

/**
 * One order the harness creates before the agent runs.
 * `from_cart` checks out the cart that `setup.cart` just seeded.
 * The shop assigns `order_id`. The harness passes that id as `order_id`.
 */
export interface AgentTaskSeedOrder {
  from_cart: true;
}

/**
 * World the harness builds for one task, and the permissions it grants the agent.
 * Seeding the cart and checking out use the harness's own shop permissions.
 * `permissions` is the grant on the agent request, not that seed call.
 */
/** One loan the harness creates on the library mock before the agent runs. */
export interface LibrarySeedLoan {
  loan_id: string;
  book_id: string;
  patron_id: string;
  /** Renewals already on the loan. A new loan uses 0. */
  renewals: number;
}

export interface AgentTaskSetup {
  cart: AgentTaskCartLine[];
  orders: AgentTaskSeedOrder[];
  permissions: string[];
  /** Present only on library tasks. Shop tasks omit it. */
  library?: {
    loans: LibrarySeedLoan[];
  };
}

/**
 * Document shape of `TaskEvalset`.
 * Only 1 is valid in this contract. A consumer that does not know the version
 * must reject the document instead of guessing.
 */
export const TASK_EVALSET_VERSION = 1 as const;

/**
 * Document shape of `OtelSourceConfig` and of an OTel import batch.
 * Only 1 is valid in this contract.
 */
export const OTEL_SOURCE_VERSION = 1 as const;

export const OTEL_IMPORT_VERSION = 1 as const;

export type OtelSourceVersion = typeof OTEL_SOURCE_VERSION;

export type OtelImportVersion = typeof OTEL_IMPORT_VERSION;

export type OtelSourceAuthType = "none" | "bearer";

/** One HTTP traces URL on `Agent.otel.prod` or `Agent.otel.test`. */
export interface OtelSourceEndpoint {
  endpoint: string;
  auth: {
    type: OtelSourceAuthType;
    /** Required when `type` is `bearer`. Absent when `type` is `none`. */
    token_env?: string;
  };
  /** When set, an import item must name this `service.name`. */
  service_name?: string;
}

/**
 * Dual OpenTelemetry sources registered on an agent.
 * `schema_id` is the lab remap. The mock HTTP route does not choose it.
 */
export interface OtelSourceConfig {
  version: OtelSourceVersion;
  schema_id?: string;
  prod: OtelSourceEndpoint;
  test: OtelSourceEndpoint;
}

export const SHOP_OTEL_SCHEMA_A_ID = "mesa.otel.shop.a" as const;

export const LIBRARY_OTEL_SCHEMA_B_ID = "mesa.otel.library.b" as const;

export const MOCK_OTEL_TRACES_PATH = "/internal/otel/traces" as const;

export type ShopOtelSchemaAId = typeof SHOP_OTEL_SCHEMA_A_ID;

export type LibraryOtelSchemaBId = typeof LIBRARY_OTEL_SCHEMA_B_ID;

export type OtelMockChannel = "prod" | "test";

/**
 * One fixture-backed OTel source on `Agent.otel_mock`.
 * `readShopOtelMock` / `readLibraryOtelMock` read `fixture_path` and do not call HTTP.
 */
export interface OtelMockSource {
  fixture_path: string;
}

/**
 * Dual fixture sources and a schema remap. Shop mapping A or library mapping B.
 */
export interface OtelMockConfig {
  mode: "fixture";
  schema_id: ShopOtelSchemaAId | LibraryOtelSchemaBId;
  schema_path: string;
  sources: {
    prod: OtelMockSource;
    test: OtelMockSource;
  };
}

export type TaskEvalsetVersion = typeof TASK_EVALSET_VERSION;

/**
 * One user-written case a later Grok judgment may read for this task.
 * `expectation` says what to look for in the Trace or Run.
 * `rubric`, when present, says how to score that expectation.
 * Neither field is a world-state check. Those stay on `success_test`.
 */
export interface TaskEvalCase {
  /** Stable id within this task's evalset. Unique among that task's cases. */
  case_id: string;
  /** What the judge should look for. Not a mock-state assertion. */
  expectation: string;
  /** How to score the expectation. Free text. Optional. Does not write `outcome.verifier`. */
  rubric?: string;
}

/**
 * User-supplied material for a later Grok judgment of this task's Run or Trace.
 * Optional on the task. Omit it, or send `version` 1 with `cases: []`, when
 * there is nothing for the judge to read. The deterministic verifier does not
 * read this object and does not write `outcome.verifier` from it.
 */
export interface TaskEvalset {
  version: TaskEvalsetVersion;
  cases: TaskEvalCase[];
}

export interface AgentTask {
  task_id: string;
  title: string;
  prompt: string;
  setup: AgentTaskSetup;
  success_test: {
    type: "verifier_checks";
    checks: AgentTaskCheck[];
  };
  /**
   * Judge input for this task. Absent when the author supplied none.
   * Not a verifier check.
   */
  evalset?: TaskEvalset;
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
  /**
   * Mock world for this agent. `base_url` is the mock, not `instance.base_url`.
   * A shop world records the mock shop. The harness still calls `MOCK_SHOP_URL`
   * for that kind, so a test can point the process at another shop.
   * A library world is the library mock the harness calls.
   */
  world?: {
    kind: "shop" | "library";
    base_url: string;
  };
  /**
   * Dual OpenTelemetry sources for this agent. Absent when the author registered none.
   * Not a Trace, and not a verifier. `schema_id` is the lab remap (`mesa.otel.shop.a` or `mesa.otel.library.b`).
   */
  otel?: OtelSourceConfig;
  /**
   * Fixture fallback for schema remap A or B. Demo pull uses `otel.prod` and `otel.test` over HTTP.
   */
  otel_mock?: OtelMockConfig;
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

/**
 * Body of `POST /v1/tasks/run`.
 * The harness builds it and the reference agent reads it. It is not a Trace,
 * a Run, or an Agent document, and it has no JSON Schema.
 * `task` is the definition the agent plans from. `prompt` is the text it sees:
 * `task.prompt`, plus an attached note when the harness added one.
 * `fix_kinds` is optional. Omit it, or send `[]`, when the run applies no fix.
 */
export interface AgentRunRequest {
  agent_id: string;
  task_id: string;
  /** Full task. The reference agent plans from this object. */
  task: AgentTask;
  prompt: string;
  session_id: string;
  permissions: string[];
  mock_base_url: string;
  /** Present when `task.setup` created an order the agent must use. */
  order_id?: string;
  /**
   * Fixes to apply on this attempt.
   * Only `controlled_retry`, `pre_response_check`, and `permission_guard`.
   */
  fix_kinds?: FixKind[];
}
