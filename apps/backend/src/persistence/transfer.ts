import type { Agent, Run, Trace } from "@mesa/shared";
import { validateAgent, validateRun, validateTrace } from "@mesa/shared/validate";
import { SEEDED_AGENT_IDS, type AgentStore, type SeedReport } from "../agents/store.js";
import { isRecord } from "../util.js";
import { seedDemoRunsAndTraces, type DemoSeedReport } from "./demo-seed.js";
import {
  assertUtcTimestamp,
  orderPreservingTimestamp,
  type RunStore,
  type StoredDocument,
} from "./store.js";

/** Backup file marker. Import rejects any other value. */
export const PERSISTENCE_EXPORT_FORMAT = "mesa-persistence-v1" as const;

export type PersistenceExportSource = "postgres" | "memory" | "http";
export type CreatedAtSource = "column" | "order";

/**
 * Agents are the Agent documents (`created_at` is a field).
 * Runs and traces keep the first-insert time beside the document, because that
 * time is not a Run or Trace field. `created_at_source` says where it came from.
 */
export interface PersistenceExport {
  format: typeof PERSISTENCE_EXPORT_FORMAT;
  exported_at: string;
  source: PersistenceExportSource;
  created_at_source: CreatedAtSource;
  agents: Agent[];
  runs: Array<StoredDocument<Run>>;
  traces: Array<StoredDocument<Trace>>;
}

export interface RowCounts {
  inserted: number;
  updated: number;
}

export interface ImportCounts {
  agents: RowCounts;
  runs: RowCounts;
  traces: RowCounts;
}

export interface ResetCounts {
  agents_deleted: number;
  runs_deleted: number;
  traces_deleted: number;
  /**
   * One result per demo seed.
   * `kept`: the row validated and is newer than the fixture, or the same age with the same endpoints.
   * `refreshed`: the stored row was invalid, older, or the same age with different endpoints, and was rewritten.
   * `inserted`: the id was missing.
   */
  seed: SeedReport;
  /** Insert-if-missing for demo runs and traces after the wipe. Existing ids are kept. */
  demo: DemoSeedReport;
}

export class PersistenceTransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceTransferError";
  }
}

const EXPORT_KEYS = [
  "format",
  "exported_at",
  "source",
  "created_at_source",
  "agents",
  "runs",
  "traces",
] as const;

function fail(message: string): never {
  throw new PersistenceTransferError(message);
}

function bump(counts: RowCounts, outcome: "inserted" | "updated"): void {
  counts[outcome] += 1;
}

function byCreatedThenId<T extends { created_at: string }>(
  idOf: (row: T) => string,
): (left: T, right: T) => number {
  return (left, right) => {
    const created = left.created_at.localeCompare(right.created_at);
    if (created !== 0) return created;
    return idOf(left).localeCompare(idOf(right));
  };
}

function assertUnique(ids: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) fail(`Duplicate ${label} ${id}.`);
    seen.add(id);
  }
}

function requireAgent(value: unknown, index: number): Agent {
  const result = validateAgent(structuredClone(value));
  if (!result.ok) {
    fail(`agents[${index}] failed validateAgent: ${result.errors.join("; ")}`);
  }
  return result.value;
}

function requireRunRow(value: unknown, index: number): StoredDocument<Run> {
  if (!isRecord(value)) fail(`runs[${index}] must be an object with created_at and document.`);
  const result = validateRun(structuredClone(value.document));
  if (!result.ok) fail(`runs[${index}] failed validateRun: ${result.errors.join("; ")}`);
  let createdAt: string;
  try {
    createdAt = assertUtcTimestamp(
      typeof value.created_at === "string" ? value.created_at : "",
      `runs[${index}] created_at`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(message);
  }
  return { created_at: createdAt, document: result.value };
}

function requireTraceRow(value: unknown, index: number): StoredDocument<Trace> {
  if (!isRecord(value)) fail(`traces[${index}] must be an object with created_at and document.`);
  const result = validateTrace(structuredClone(value.document));
  if (!result.ok) fail(`traces[${index}] failed validateTrace: ${result.errors.join("; ")}`);
  let createdAt: string;
  try {
    createdAt = assertUtcTimestamp(
      typeof value.created_at === "string" ? value.created_at : "",
      `traces[${index}] created_at`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(message);
  }
  return { created_at: createdAt, document: result.value };
}

/**
 * Validate every agent, run, and trace. A file that fails this check is not imported.
 * Accepts a BOM-stripped object. `JSON.parse` already accepts CR LF.
 */
export function parsePersistenceExport(value: unknown): PersistenceExport {
  if (!isRecord(value)) fail("Export file must be a JSON object.");
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!EXPORT_KEYS.includes(key as (typeof EXPORT_KEYS)[number])) {
      fail(`Unexpected export field ${key}.`);
    }
  }
  for (const key of EXPORT_KEYS) {
    if (!Object.hasOwn(value, key)) fail(`Export is missing ${key}.`);
  }
  if (value.format !== PERSISTENCE_EXPORT_FORMAT) {
    fail(`Export format must be ${PERSISTENCE_EXPORT_FORMAT}.`);
  }
  let exportedAt: string;
  try {
    exportedAt = assertUtcTimestamp(
      typeof value.exported_at === "string" ? value.exported_at : "",
      "exported_at",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(message);
  }
  const source = value.source;
  if (source !== "postgres" && source !== "memory" && source !== "http") {
    fail("Export source must be postgres, memory, or http.");
  }
  const createdAtSource = value.created_at_source;
  if (createdAtSource !== "column" && createdAtSource !== "order") {
    fail("Export created_at_source must be column or order.");
  }
  if (source === "postgres" && createdAtSource !== "column") {
    fail("A postgres export must use created_at_source column.");
  }
  if (source !== "postgres" && createdAtSource !== "order") {
    fail("A memory or http export must use created_at_source order.");
  }
  if (!Array.isArray(value.agents)) fail("Export agents must be an array.");
  if (!Array.isArray(value.runs)) fail("Export runs must be an array.");
  if (!Array.isArray(value.traces)) fail("Export traces must be an array.");

  const agents = value.agents.map((item, index) => requireAgent(item, index));
  const runs = value.runs.map((item, index) => requireRunRow(item, index));
  const traces = value.traces.map((item, index) => requireTraceRow(item, index));
  assertUnique(
    agents.map((agent) => agent.agent_id),
    "agent_id",
  );
  assertUnique(
    runs.map((row) => row.document.run_id),
    "run_id",
  );
  assertUnique(
    traces.map((row) => row.document.trace_id),
    "trace_id",
  );

  return {
    format: PERSISTENCE_EXPORT_FORMAT,
    exported_at: exportedAt,
    source,
    created_at_source: createdAtSource,
    agents,
    runs,
    traces,
  };
}

export function parsePersistenceExportText(text: string): PersistenceExport {
  const stripped = text.replace(/^\uFEFF/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped) as unknown;
  } catch {
    fail("Export file is not JSON.");
  }
  return parsePersistenceExport(parsed);
}

/** UTF-8 JSON with LF newlines. No BOM and no CR, so a Windows checkout does not change the bytes we write. */
export function serializePersistenceExport(data: PersistenceExport): string {
  const checked = parsePersistenceExport(data);
  const text = `${JSON.stringify(checked, null, 2)}\n`;
  if (text.includes("\r")) {
    fail("Export serialization produced a carriage return.");
  }
  return text;
}

function sourceOf(agents: AgentStore, runs: RunStore): "postgres" | "memory" {
  if (agents.kind === "postgres" && runs.kind === "postgres") return "postgres";
  if (agents.kind === "memory" && runs.kind === "memory") return "memory";
  fail(`Refusing to export mixed stores (agent_store=${agents.kind}, run_store=${runs.kind}).`);
}

/**
 * Read both stores and validate every document before returning.
 * Does not write. Postgres `created_at` is the column. Memory uses the import
 * time when the row came from a file, otherwise an order-preserving stand-in.
 */
export async function exportStores(
  agents: AgentStore,
  runs: RunStore,
  now = new Date(),
): Promise<PersistenceExport> {
  const source = sourceOf(agents, runs);
  const agentDocs = await agents.list();
  const runRows = await runs.listRunRecords();
  const traceRows = await runs.listTraceRecords();
  return parsePersistenceExport({
    format: PERSISTENCE_EXPORT_FORMAT,
    exported_at: now.toISOString(),
    source,
    created_at_source: source === "postgres" ? "column" : "order",
    agents: agentDocs,
    runs: runRows,
    traces: traceRows,
  });
}

/**
 * Upsert every document. Missing ids are inserted with the file's `created_at`.
 * Ids that already exist keep the stored `created_at` and take the file's document.
 * Rows that are not in the file are left in place. Call `resetKeepingSeed` first
 * when the file should be the whole database.
 * Validates again before the first write.
 */
export async function importPersistence(
  agents: AgentStore,
  runs: RunStore,
  raw: PersistenceExport,
): Promise<ImportCounts> {
  const data = parsePersistenceExport(raw);
  const counts: ImportCounts = {
    agents: { inserted: 0, updated: 0 },
    runs: { inserted: 0, updated: 0 },
    traces: { inserted: 0, updated: 0 },
  };
  for (const agent of data.agents) {
    bump(counts.agents, await agents.upsertImported(agent));
  }
  const runRows = [...data.runs].sort(byCreatedThenId((row) => row.document.run_id));
  for (const row of runRows) {
    bump(counts.runs, await runs.upsertImportedRun(row.document, row.created_at));
  }
  const traceRows = [...data.traces].sort(byCreatedThenId((row) => row.document.trace_id));
  for (const row of traceRows) {
    bump(counts.traces, await runs.upsertImportedTrace(row.document, row.created_at));
  }
  return counts;
}

/**
 * Delete every run, every trace, and every agent except the demo seeds.
 * A valid seed newer than its fixture is kept.
 * An invalid or older seed is rewritten from its fixture.
 * A row at the fixture timestamp is rewritten when its runtime or world URL differs.
 * A missing seed is inserted.
 * Demo runs and traces are then inserted when those ids are absent.
 * Not an HTTP route. Does not read a seed through `get`, so an invalid document
 * does not abort the reset.
 */
export async function resetKeepingSeed(agents: AgentStore, runs: RunStore): Promise<ResetCounts> {
  const deleted = await runs.deleteAllRunsAndTraces();
  const agentsDeleted = await agents.deleteAgentsExceptSeed();
  const seed = await agents.seedIfMissing();
  for (const agentId of SEEDED_AGENT_IDS) {
    const seedAfter = await agents.get(agentId);
    if (!seedAfter || seedAfter.agent_id !== agentId) {
      fail(`Reset failed to keep ${agentId}.`);
    }
  }
  const demo = await seedDemoRunsAndTraces(runs);
  return {
    agents_deleted: agentsDeleted,
    runs_deleted: deleted.runs,
    traces_deleted: deleted.traces,
    seed,
    demo,
  };
}

/**
 * What HTTP export cannot see. Printed by the CLI. The running process is not modified.
 * A Postgres backend still serves documents without the SQL `created_at` column.
 */
export function httpExportAdvisory(agentStore: string, runStore: string): string {
  if (agentStore === "postgres" || runStore === "postgres") {
    return (
      `GET /health reports agent_store=${agentStore} and run_store=${runStore}. ` +
      "HTTP export cannot read the SQL created_at column. " +
      "The file uses order-preserving timestamps so a later import keeps list order. " +
      "Export again with DATABASE_URL and without --base-url to copy the original timestamps."
    );
  }
  return (
    "HTTP export reads the running process. Runs and traces have no created_at column on this API. " +
    "The file uses order-preserving timestamps. " +
    "Import into Postgres stores those timestamps as the first-insert time. " +
    "There is no HTTP route that writes a saved Run or Trace back, so import needs DATABASE_URL."
  );
}

function assertHttpBase(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    fail("--base-url must be an http(s) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail("--base-url must be an http(s) URL.");
  }
  return baseUrl.replace(/\/$/, "");
}

async function getJson(url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`GET ${url} failed. ${message}`);
  }
  const text = await response.text();
  if (!response.ok) fail(`GET ${url} returned ${response.status}.`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail(`GET ${url} did not return JSON.`);
  }
}

function readHealth(value: unknown): { agent_store: string; run_store: string } {
  if (!isRecord(value)) fail("GET /health did not return an object.");
  if (value.service !== "backend") fail("GET /health is not the MESA backend.");
  if (typeof value.agent_store !== "string" || typeof value.run_store !== "string") {
    fail("GET /health did not include agent_store and run_store.");
  }
  return { agent_store: value.agent_store, run_store: value.run_store };
}

function readAgents(value: unknown): Agent[] {
  if (!isRecord(value) || !Array.isArray(value.agents)) fail("GET /agents did not return { agents: [] }.");
  return value.agents.map((item, index) => requireAgent(item, index));
}

/** `GET /runs` is newest first. The export file is oldest first, matching the store. */
function readRunsOldestFirst(value: unknown): Run[] {
  if (!isRecord(value) || !Array.isArray(value.runs)) fail("GET /runs did not return { runs: [] }.");
  const newestFirst = value.runs.map((item, index) => {
    const result = validateRun(structuredClone(item));
    if (!result.ok) fail(`GET /runs item ${index} failed validateRun: ${result.errors.join("; ")}`);
    return result.value;
  });
  return newestFirst.reverse();
}

function readTraces(value: unknown): Trace[] {
  if (!isRecord(value) || !Array.isArray(value.traces)) fail("GET /traces did not return { traces: [] }.");
  return value.traces.map((item, index) => {
    const result = validateTrace(structuredClone(item));
    if (!result.ok) fail(`GET /traces item ${index} failed validateTrace: ${result.errors.join("; ")}`);
    return result.value;
  });
}

export interface HttpExport {
  data: PersistenceExport;
  advisory: string;
  agent_store: string;
  run_store: string;
}

/**
 * Read a running backend. This is how a memory process is copied: its rows exist
 * only in that process, so a second process cannot open them.
 * `GET /runs` does not include the SQL `created_at` column. Timestamps in the file
 * preserve list order and are not the database column.
 */
export async function exportFromHttp(baseUrl: string, now = new Date()): Promise<HttpExport> {
  const root = assertHttpBase(baseUrl);
  const health = readHealth(await getJson(`${root}/health`));
  const agents = readAgents(await getJson(`${root}/agents`));
  const traces = readTraces(await getJson(`${root}/traces`));
  const runs = readRunsOldestFirst(await getJson(`${root}/runs`));
  const data = parsePersistenceExport({
    format: PERSISTENCE_EXPORT_FORMAT,
    exported_at: now.toISOString(),
    source: "http",
    created_at_source: "order",
    agents,
    runs: runs.map((document, index) => ({
      created_at: orderPreservingTimestamp(index),
      document,
    })),
    traces: traces.map((document, index) => ({
      created_at: orderPreservingTimestamp(index),
      document,
    })),
  });
  return {
    data,
    advisory: httpExportAdvisory(health.agent_store, health.run_store),
    agent_store: health.agent_store,
    run_store: health.run_store,
  };
}

/** Host and database only. The user and password are not included. */
export function databaseTargetLabel(connectionString: string): string {
  try {
    const parsed = new URL(connectionString);
    const database = parsed.pathname.replace(/^\//, "") || "(no database)";
    const host = parsed.hostname || "(no host)";
    const port = parsed.port === "" ? "" : `:${parsed.port}`;
    return `${host}${port}/${database}`;
  } catch {
    return "(unparsed DATABASE_URL)";
  }
}
