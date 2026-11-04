/**
 * TypeScript mirror of `schemas/agent.schema.json`.
 * JSON Schema is the source of truth. Update both together and bump CONTRACT_VERSION.
 */

import type { JsonValue } from "./trace.js";

export type AgentInstanceKind = "reference" | "external";

export interface AgentInstance {
  kind: AgentInstanceKind;
  base_url?: string;
  runtime?: string;
}

export interface TestInstance {
  base_url: string;
  runtime?: string;
}

export interface TraceStoreRef {
  store: string;
  path_or_url?: string;
}

export interface AgentToolDoc {
  name: string;
  description?: string;
}

export interface AgentDocs {
  prompt_summary?: string;
  tools: AgentToolDoc[];
  constraints: string[];
  config_notes?: string;
}

/**
 * One deterministic check. `assertion` is interpreted by the verifier against mock state.
 * It is not a prompt for Grok.
 */
export interface VerifierCheckSpec {
  check_id: string;
  description: string;
  assertion: Record<string, JsonValue>;
}

export interface SuccessTest {
  type: "verifier_checks";
  checks: VerifierCheckSpec[];
}

export interface AgentTask {
  task_id: string;
  title: string;
  prompt: string;
  success_test: SuccessTest;
}

export interface Agent {
  agent_id: string;
  name: string;
  description?: string;
  created_at: string;
  updated_at: string;
  instance: AgentInstance;
  test_instance: TestInstance;
  traces: TraceStoreRef;
  docs: AgentDocs;
  tasks: AgentTask[];
}
