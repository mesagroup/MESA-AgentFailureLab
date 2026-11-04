/**
 * Shared contracts for MESA Agent Failure Lab.
 *
 * JSON Schema files under `schemas/` are the source of truth for Trace, Agent, and Run.
 * `src/types.ts` is a hand-written mirror. OpenAPI is not the source of truth.
 * Validators live in `@mesa/shared/validate` so this entry stays free of Node built-ins.
 */

export const CONTRACT_VERSION = "0.1.0";

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
  TRACE_STATUSES,
  TRACE_STORE_KINDS,
} from "./types.js";

export type {
  Agent,
  AgentInstanceKind,
  AgentRunRequest,
  AgentTask,
  AgentTaskCheck,
  AgentToolDoc,
  Diagnosis,
  FaultCategory,
  FaultLabel,
  FixKind,
  InjectionPlan,
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
