import { randomUUID } from "node:crypto";
import { isSeededAgentId, SEEDED_AGENT_IDS, type Agent } from "@mesa/shared";
import { validateAgent } from "@mesa/shared/validate";
import { loadGiftDeskAgent, loadReferenceAgent, loadSeedAgents } from "../reference-agent.js";
import { isRecord } from "../util.js";

/** Shopping demo seed. DELETE of this id is rejected. */
export const REFERENCE_AGENT_ID = SEEDED_AGENT_IDS[0];

/** Gift desk demo seed. DELETE of this id is rejected. */
export const GIFT_DESK_AGENT_ID = SEEDED_AGENT_IDS[1];

export { isSeededAgentId, SEEDED_AGENT_IDS };

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
  constructor(agentId: string) {
    super(`Agent ${agentId} is a demo seed and cannot be deleted.`);
    this.name = "ProtectedAgentError";
  }
}

/** What `seedIfMissing` did to one demo seed. */
export type SeedResult = "inserted" | "kept" | "refreshed";

/** One result per seeded agent id. */
export type SeedReport = Readonly<Record<string, SeedResult>>;

/**
 * A row is present, but its document does not satisfy the Agent schema.
 * List routes skip it. `get` still throws so a direct read reports the row.
 */
export class StoredAgentSchemaError extends Error {
  readonly agentId: string;
  readonly errors: string[];

  constructor(agentId: string, errors: string[]) {
    super(`Stored agent failed schema: ${errors.join("; ")}`);
    this.name = "StoredAgentSchemaError";
    this.agentId = agentId;
    this.errors = errors;
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
  /**
   * Insert each demo fixture when that id is absent.
   * Rewrite a row when its document fails `validateAgent`, or when its
   * `updated_at` is earlier than that fixture. A valid row at the same age or
   * newer stays, including one renamed with PUT.
   */
  seedIfMissing(): Promise<SeedReport>;
  /**
   * Insert or replace one agent from a backup file.
   * The document must already include `agent_id`, `created_at`, and `updated_at`.
   * When the id exists, the stored `created_at` stays and the rest of the document is replaced.
   * A stored document that fails the Agent schema is still replaced.
   * Not an HTTP route.
   */
  upsertImported(agent: Agent): Promise<"inserted" | "updated">;
  /**
   * Delete every agent except the demo seeds. Those rows are never removed.
   * Not an HTTP route. `DELETE` of a seed id stays 409.
   */
  deleteAgentsExceptSeed(): Promise<number>;
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

export function agentFromReplace(
  existing: { readonly created_at: string },
  agentId: string,
  body: unknown,
  now = new Date(),
): Agent {
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

/** Backup import. Requires the server fields. Does not assign a new id or a new timestamp. */
export function importedAgent(body: unknown): Agent {
  if (!isRecord(body)) {
    throw new AgentValidationError(["Body must be a JSON object."]);
  }
  if (typeof body.agent_id !== "string" || body.agent_id.trim() === "") {
    throw new AgentValidationError(["agent_id is required on import."]);
  }
  return parseAgent(body);
}

export function referenceSeed(): Agent {
  return seedFixture(loadReferenceAgent(), REFERENCE_AGENT_ID);
}

export function giftDeskSeed(): Agent {
  return seedFixture(loadGiftDeskAgent(), GIFT_DESK_AGENT_ID);
}

export function seedFixtures(): Agent[] {
  return loadSeedAgents().map((agent) => {
    if (!isSeededAgentId(agent.agent_id)) {
      throw new Error(`Seed fixture agent_id is ${agent.agent_id}, which is not a demo seed.`);
    }
    return structuredClone(agent);
  });
}

function seedFixture(agent: Agent, expectedId: string): Agent {
  const copy = structuredClone(agent);
  if (copy.agent_id !== expectedId) {
    throw new Error(`Seed fixture agent_id is ${copy.agent_id}, expected ${expectedId}.`);
  }
  return copy;
}

export function rawAgentId(document: unknown): string {
  if (!isRecord(document) || typeof document.agent_id !== "string" || document.agent_id.trim() === "") {
    throw new Error("A raw agent document needs a non-empty agent_id.");
  }
  return document.agent_id;
}

/** Date-time from a stored document, or `fallback` when the field is missing or not a date. */
export function storedTimestamp(value: unknown, key: "created_at" | "updated_at", fallback: string): string {
  if (!isRecord(value) || typeof value[key] !== "string") return fallback;
  const parsed = Date.parse(value[key]);
  if (Number.isNaN(parsed)) return fallback;
  return new Date(parsed).toISOString();
}

/**
 * `undefined` when the stored seed validates and is not older than the fixture.
 * Otherwise the reason the fixture should replace the row.
 */
export function seedRewriteReason(stored: unknown, fixture: Agent): string | undefined {
  const result = validateAgent(structuredClone(stored));
  if (!result.ok) {
    return `stored document failed schema: ${result.errors.join("; ")}`;
  }
  const storedMs = Date.parse(result.value.updated_at);
  const fixtureMs = Date.parse(fixture.updated_at);
  if (Number.isNaN(storedMs) || storedMs < fixtureMs) {
    return `stored updated_at ${result.value.updated_at} is older than the fixture ${fixture.updated_at}`;
  }
  return undefined;
}

export function readStoredAgent(value: unknown): Agent {
  const result = validateAgent(structuredClone(value));
  if (!result.ok) throw new StoredAgentSchemaError(rawAgentIdOrUnknown(value), result.errors);
  return result.value;
}

/** Valid documents, in input order. Invalid ones are logged and omitted. */
export function readableStoredAgents(documents: readonly unknown[]): Agent[] {
  const agents: Agent[] = [];
  for (const document of documents) {
    const result = validateAgent(structuredClone(document));
    if (!result.ok) {
      console.warn(
        `Skipping stored agent ${rawAgentIdOrUnknown(document)}: stored document failed schema: ${result.errors.join("; ")}`,
      );
      continue;
    }
    agents.push(result.value);
  }
  return agents;
}

export function warnSeedRewritten(agentId: string, reason: string): void {
  console.warn(`Rewrote stored agent ${agentId} from the fixture: ${reason}`);
}

function rawAgentIdOrUnknown(value: unknown): string {
  if (!isRecord(value) || typeof value.agent_id !== "string" || value.agent_id.trim() === "") {
    return "(missing agent_id)";
  }
  return value.agent_id;
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

/**
 * Process-local agent store.
 * `initialDocuments` are rows already present at startup. Tests plant a stale
 * seed this way. The constructor then inserts or rewrites each demo seed.
 * A later empty construction drops every row except those seeds.
 */
export class MemoryAgentStore implements AgentStore {
  readonly kind = "memory" as const;
  private readonly agents = new Map<string, unknown>();

  constructor(initialDocuments?: readonly unknown[]) {
    if (initialDocuments) {
      for (const document of initialDocuments) this.rememberRaw(document);
    }
    this.applySeeds();
  }

  async list(): Promise<Agent[]> {
    return readableStoredAgents([...this.agents.values()]).sort(byCreatedAt);
  }

  async get(agentId: string): Promise<Agent | undefined> {
    if (!this.agents.has(agentId)) return undefined;
    return readStoredAgent(this.agents.get(agentId));
  }

  async create(body: unknown): Promise<Agent> {
    const agent = agentFromCreate(body);
    if (this.agents.has(agent.agent_id)) throw new AgentConflictError(agent.agent_id);
    this.agents.set(agent.agent_id, agent);
    return cloneAgent(agent);
  }

  async replace(agentId: string, body: unknown): Promise<Agent> {
    if (!this.agents.has(agentId)) throw new AgentNotFoundError(agentId);
    const createdAt = storedTimestamp(this.agents.get(agentId), "created_at", new Date().toISOString());
    const agent = agentFromReplace({ created_at: createdAt }, agentId, body);
    this.agents.set(agentId, agent);
    return cloneAgent(agent);
  }

  async delete(agentId: string): Promise<void> {
    if (isSeededAgentId(agentId)) throw new ProtectedAgentError(agentId);
    if (!this.agents.delete(agentId)) throw new AgentNotFoundError(agentId);
  }

  async seedIfMissing(): Promise<SeedReport> {
    return this.applySeeds();
  }

  async upsertImported(agent: Agent): Promise<"inserted" | "updated"> {
    const valid = importedAgent(agent);
    if (!this.agents.has(valid.agent_id)) {
      this.agents.set(valid.agent_id, valid);
      return "inserted";
    }
    const createdAt = storedTimestamp(this.agents.get(valid.agent_id), "created_at", valid.created_at);
    const next = importedAgent({ ...valid, created_at: createdAt });
    this.agents.set(valid.agent_id, next);
    return "updated";
  }

  async deleteAgentsExceptSeed(): Promise<number> {
    let removed = 0;
    for (const agentId of [...this.agents.keys()]) {
      if (isSeededAgentId(agentId)) continue;
      this.agents.delete(agentId);
      removed += 1;
    }
    return removed;
  }

  async close(): Promise<void> {}

  /** Insert or replace one document without validation. Tests plant a stale row with this. */
  putRawForTests(document: unknown): void {
    this.rememberRaw(document);
  }

  private rememberRaw(document: unknown): void {
    this.agents.set(rawAgentId(document), structuredClone(document));
  }

  private applySeeds(): SeedReport {
    const report: Record<string, SeedResult> = {};
    for (const fixture of seedFixtures()) {
      report[fixture.agent_id] = this.applyOneSeed(fixture);
    }
    return report;
  }

  private applyOneSeed(fixture: Agent): SeedResult {
    const stored = this.agents.get(fixture.agent_id);
    if (stored === undefined) {
      this.agents.set(fixture.agent_id, fixture);
      return "inserted";
    }
    const reason = seedRewriteReason(stored, fixture);
    if (reason === undefined) return "kept";
    warnSeedRewritten(fixture.agent_id, reason);
    this.agents.set(fixture.agent_id, fixture);
    return "refreshed";
  }
}
