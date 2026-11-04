import { randomUUID } from "node:crypto";
import type { Agent } from "@mesa/shared";
import { validateAgent } from "@mesa/shared/validate";
import { loadReferenceAgent } from "../reference-agent.js";
import { isRecord } from "../util.js";

/** Demo seed. DELETE of this id is rejected. */
export const REFERENCE_AGENT_ID = "reference-shop";

export type AgentStoreKind = "memory" | "postgres";

export class AgentValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors.join("; "));
    this.name = "AgentValidationError";
    this.errors = errors;
  }
}

export class AgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`No agent ${agentId}`);
    this.name = "AgentNotFoundError";
  }
}

export class AgentConflictError extends Error {
  constructor(agentId: string) {
    super(`Agent ${agentId} already exists.`);
    this.name = "AgentConflictError";
  }
}

export class ProtectedAgentError extends Error {
  constructor() {
    super(`Agent ${REFERENCE_AGENT_ID} is the demo seed and cannot be deleted.`);
    this.name = "ProtectedAgentError";
  }
}

/**
 * Agent registration store. Writes are validated against the Agent schema.
 * Runs and traces are not stored here.
 */
export interface AgentStore {
  readonly kind: AgentStoreKind;
  list(): Promise<Agent[]>;
  get(agentId: string): Promise<Agent | undefined>;
  create(body: unknown): Promise<Agent>;
  replace(agentId: string, body: unknown): Promise<Agent>;
  delete(agentId: string): Promise<void>;
  /** Insert the reference-shop fixture when that id is absent. Does not overwrite. */
  seedIfMissing(): Promise<void>;
  close(): Promise<void>;
}

export function agentFromCreate(body: unknown, now = new Date()): Agent {
  if (!isRecord(body)) {
    throw new AgentValidationError(["Body must be a JSON object."]);
  }
  const stamp = now.toISOString();
  const next: Record<string, unknown> = { ...body };
  if (!Object.hasOwn(next, "agent_id")) next.agent_id = randomUUID();
  if (!Object.hasOwn(next, "created_at")) next.created_at = stamp;
  if (!Object.hasOwn(next, "updated_at")) next.updated_at = stamp;
  return parseAgent(next);
}

export function agentFromReplace(existing: Agent, agentId: string, body: unknown, now = new Date()): Agent {
  if (!isRecord(body)) {
    throw new AgentValidationError(["Body must be a JSON object."]);
  }
  if (Object.hasOwn(body, "agent_id") && body.agent_id !== agentId) {
    throw new AgentValidationError([`agent_id must be ${agentId}.`]);
  }
  const next: Record<string, unknown> = {
    ...body,
    agent_id: agentId,
    updated_at: now.toISOString(),
  };
  if (!Object.hasOwn(body, "created_at")) next.created_at = existing.created_at;
  return parseAgent(next);
}

export function referenceSeed(): Agent {
  const agent = structuredClone(loadReferenceAgent());
  if (agent.agent_id !== REFERENCE_AGENT_ID) {
    throw new Error(`Reference fixture agent_id is ${agent.agent_id}, expected ${REFERENCE_AGENT_ID}.`);
  }
  return agent;
}

function parseAgent(value: unknown): Agent {
  const result = validateAgent(structuredClone(value));
  if (!result.ok) throw new AgentValidationError(result.errors);
  return result.value;
}

function cloneAgent(agent: Agent): Agent {
  return structuredClone(agent);
}

function byCreatedAt(left: Agent, right: Agent): number {
  const created = left.created_at.localeCompare(right.created_at);
  if (created !== 0) return created;
  return left.agent_id.localeCompare(right.agent_id);
}

/** Process-local agent store. A restart drops every row except the reseeded demo agent. */
export class MemoryAgentStore implements AgentStore {
  readonly kind = "memory" as const;
  private readonly agents = new Map<string, Agent>();

  constructor() {
    this.insertSeed();
  }

  async list(): Promise<Agent[]> {
    return [...this.agents.values()].map((agent) => cloneAgent(agent)).sort(byCreatedAt);
  }

  async get(agentId: string): Promise<Agent | undefined> {
    const found = this.agents.get(agentId);
    return found ? cloneAgent(found) : undefined;
  }

  async create(body: unknown): Promise<Agent> {
    const agent = agentFromCreate(body);
    if (this.agents.has(agent.agent_id)) throw new AgentConflictError(agent.agent_id);
    this.agents.set(agent.agent_id, agent);
    return cloneAgent(agent);
  }

  async replace(agentId: string, body: unknown): Promise<Agent> {
    const existing = this.agents.get(agentId);
    if (!existing) throw new AgentNotFoundError(agentId);
    const agent = agentFromReplace(existing, agentId, body);
    this.agents.set(agentId, agent);
    return cloneAgent(agent);
  }

  async delete(agentId: string): Promise<void> {
    if (agentId === REFERENCE_AGENT_ID) throw new ProtectedAgentError();
    if (!this.agents.delete(agentId)) throw new AgentNotFoundError(agentId);
  }

  async seedIfMissing(): Promise<void> {
    this.insertSeed();
  }

  async close(): Promise<void> {}

  private insertSeed(): void {
    if (this.agents.has(REFERENCE_AGENT_ID)) return;
    this.agents.set(REFERENCE_AGENT_ID, referenceSeed());
  }
}
