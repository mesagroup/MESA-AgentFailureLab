/**
 * Shared contracts for MESA Agent Failure Lab.
 *
 * JSON Schema files under `schemas/` are the source of truth for Trace, Agent, and Run.
 * `src/types.ts` is a hand-written mirror. OpenAPI is not the source of truth.
 * Validators live in `@mesa/shared/validate` so this entry stays free of Node built-ins.
 */

export const CONTRACT_VERSION = "0.3.0";

/**
 * Demo agents inserted at startup.
 * Both are editable. A valid row newer than its fixture is kept.
 * A row at the fixture timestamp is rewritten when its runtime or world URL differs.
 * `DELETE` of either id is rejected, and `db:reset` keeps both rows.
 */
export const SEEDED_AGENT_IDS = ["reference-shop", "external-library"] as const;

export function isSeededAgentId(agentId: string): boolean {
  return (SEEDED_AGENT_IDS as readonly string[]).includes(agentId);
}

/** Trace paths Grok must not write. The harness and verifier own them. */
export const GROK_FORBIDDEN_WRITE_PATHS = [
  "outcome.verifier",
  "fault.injected",
  "fault.labels",
  "fault.attacker",
] as const;

export {
  AGENT_INSTANCE_KINDS,
  FAULT_CATEGORIES,
  FIX_KINDS,
  RUN_PHASES,
  RUN_STATUSES,
  STEP_ROLES,
  STEP_TYPES,
  OTEL_IMPORT_VERSION,
  OTEL_SOURCE_VERSION,
  TASK_EVALSET_VERSION,
  TRACE_STATUSES,
  TRACE_STORE_KINDS,
} from "./types.js";

export {
  CHECK_REGISTRY,
  CHECK_TYPES,
  TASK_PERMISSIONS,
  isCheckType,
  validateAgentTasks,
} from "./checks.js";

export type { CheckParamField, CheckParamType, CheckType, CheckTypeSpec } from "./checks.js";

export { planShopTask, taskNeedsOrderId } from "./shop-plan.js";
export { planLibraryTask } from "./library-plan.js";

export type { ShopPlanAction, ShopPlanResult } from "./shop-plan.js";

export type {
  Agent,
  AgentInstanceKind,
  AgentRunRequest,
  AgentTask,
  AgentTaskCartLine,
  AgentTaskCheck,
  AgentTaskSeedOrder,
  TaskEvalCase,
  TaskEvalset,
  TaskEvalsetVersion,
  LibrarySeedLoan,
  AgentTaskSetup,
  AgentToolDoc,
  Diagnosis,
  FaultCategory,
  FaultLabel,
  FixKind,
  InjectionPlan,
  OtelImportVersion,
  OtelSourceAuthType,
  OtelSourceConfig,
  OtelSourceVersion,
  Run,
  RunPhase,
  RunStatus,
  StepRole,
  StepType,
  TokenUsage,
  Trace,
  TraceFault,
  TraceOutcome,
  TraceStatus,
  TraceStep,
  TraceStoreKind,
  TraceTotals,
  VerifierCheck,
} from "./types.js";
