/**
 * Shared contracts for MESA Agent Failure Lab.
 *
 * JSON Schema files under `schemas/` are the source of truth for Trace and Agent.
 * These TypeScript types are a hand-maintained mirror. OpenAPI is not the source of truth.
 */

export const CONTRACT_VERSION = "0.1.0";

/** Trace paths Grok must not write. The harness and verifier own them. */
export const GROK_FORBIDDEN_WRITE_PATHS = [
  "outcome.verifier",
  "fault.injected",
  "fault.labels",
  "fault.attacker",
] as const;

export type { Agent, AgentDocs, AgentInstance, AgentInstanceKind, AgentTask, AgentToolDoc, SuccessTest, TestInstance, TraceStoreRef, VerifierCheckSpec } from "./agent.js";

export type { Run, RunPhase } from "./run.js";

export type {
  Diagnosis,
  DiagnosisEvidence,
  Fault,
  FaultCategory,
  FaultLabel,
  JsonValue,
  ProposedFix,
  StepRole,
  TokenUsage,
  Trace,
  TraceOutcome,
  TraceStatus,
  TraceStep,
  TraceStepType,
  TraceTotals,
  VerifierCheckResult,
  VerifierOutcome,
} from "./trace.js";
