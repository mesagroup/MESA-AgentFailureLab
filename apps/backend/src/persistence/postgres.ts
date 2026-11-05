import type { Diagnosis, OtelMockChannel, Run, Trace } from "@mesa/shared";
import pg from "pg";
import { applyMigrations, postgresPoolConfig, quoteIdent } from "../agents/postgres.js";
import {
  assertRun,
  assertTrace,
  assertUtcTimestamp,
  DuplicateTraceError,
  prepareImportedRun,
  prepareImportedTrace,
  readStoredRun,
  readStoredTrace,
  type RunStore,
  type StoredDocument,
} from "./store.js";

function timestampToIso(value: Date | string, label: string): string {
  if (value instanceof Date) return value.toISOString();
  return assertUtcTimestamp(value, label);
}

export interface PostgresRunStoreOptions {
  /**
   * Libpq search_path for this pool. Tests use a private schema so they do not
   * write the public `runs` or `traces` tables. Production leaves this unset.
   */
  searchPath?: string;
}

/**
 * Postgres-backed run and trace store. Each document is one jsonb column.
 * `created_at` is the first insert and is not part of the JSON document.
 * Saving the same id again replaces the document and keeps `created_at`.
 */
export class PostgresRunStore implements RunStore {
  readonly kind = "postgres" as const;
  private readonly pool: pg.Pool;
  private closed = false;

  constructor(connectionString: string, options: PostgresRunStoreOptions = {}) {
    const searchPath = options.searchPath;
    if (searchPath !== undefined) quoteIdent(searchPath);
    this.pool = new pg.Pool({
      ...postgresPoolConfig(connectionString),
      options: searchPath ? `-c search_path=${quoteIdent(searchPath)}` : undefined,
    });
  }

  async migrate(): Promise<void> {
    await applyMigrations(this.pool);
  }

  async saveRun(run: Run): Promise<Run> {
    const valid = assertRun(structuredClone(run));
    await this.pool.query(
      `INSERT INTO runs (run_id, agent_id, document)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (run_id) DO UPDATE
       SET agent_id = EXCLUDED.agent_id,
           document = EXCLUDED.document`,
      [valid.run_id, valid.agent_id, JSON.stringify(valid)],
    );
    return structuredClone(valid);
  }

  async getRun(runId: string): Promise<Run | undefined> {
    const result = await this.pool.query<{ document: unknown }>(
      "SELECT document FROM runs WHERE run_id = $1",
      [runId],
    );
    const row = result.rows[0];
    return row ? readStoredRun(row.document) : undefined;
  }

  async listRuns(): Promise<Run[]> {
    const result = await this.pool.query<{ document: unknown }>(
      "SELECT document FROM runs ORDER BY created_at ASC, run_id ASC",
    );
    return result.rows.map((row) => readStoredRun(row.document));
  }

  async listRunRecords(): Promise<Array<StoredDocument<Run>>> {
    const result = await this.pool.query<{ document: unknown; created_at: Date | string }>(
      "SELECT document, created_at FROM runs ORDER BY created_at ASC, run_id ASC",
    );
    return result.rows.map((row) => ({
      created_at: timestampToIso(row.created_at, "runs.created_at"),
      document: readStoredRun(row.document),
    }));
  }

  async listRunsByAgent(agentId: string): Promise<Run[]> {
    const result = await this.pool.query<{ document: unknown }>(
      `SELECT document FROM runs
       WHERE agent_id = $1
       ORDER BY created_at ASC, run_id ASC`,
      [agentId],
    );
    return result.rows.map((row) => readStoredRun(row.document));
  }

  async saveTrace(trace: Trace): Promise<Trace> {
    const valid = assertTrace(structuredClone(trace));
    await this.pool.query(
      `INSERT INTO traces (trace_id, run_id, agent_id, document, started_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)
       ON CONFLICT (trace_id) DO UPDATE
       SET run_id = EXCLUDED.run_id,
           agent_id = EXCLUDED.agent_id,
           document = EXCLUDED.document,
           started_at = EXCLUDED.started_at`,
      [valid.trace_id, valid.run_id, valid.agent_id, JSON.stringify(valid), valid.started_at],
    );
    return structuredClone(valid);
  }

  async insertTrace(trace: Trace): Promise<Trace> {
    const valid = assertTrace(structuredClone(trace));
    try {
      await this.pool.query(
        `INSERT INTO traces (trace_id, run_id, agent_id, document, started_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)`,
        [valid.trace_id, valid.run_id, valid.agent_id, JSON.stringify(valid), valid.started_at],
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateTraceError(valid.trace_id);
      throw error;
    }
    return structuredClone(valid);
  }

  async getTrace(traceId: string): Promise<Trace | undefined> {
    const result = await this.pool.query<{ document: unknown }>(
      "SELECT document FROM traces WHERE trace_id = $1",
      [traceId],
    );
    const row = result.rows[0];
    return row ? readStoredTrace(row.document) : undefined;
  }

  async saveDiagnosis(expected: Trace, diagnosis: Diagnosis): Promise<Trace | undefined> {
    const updated = assertTrace(structuredClone({ ...expected, diagnosis }));
    // jsonb equality ignores object-key order. The UPDATE is the compare-and-set;
    // a separate SELECT followed by saveTrace would lose concurrent writes.
    const result = await this.pool.query<{ document: unknown }>(
      `UPDATE traces SET document = $3::jsonb
       WHERE trace_id = $1 AND document = $2::jsonb
       RETURNING document`,
      [expected.trace_id, JSON.stringify(expected), JSON.stringify(updated)],
    );
    const row = result.rows[0];
    return row ? readStoredTrace(row.document) : undefined;
  }

  async listTraces(): Promise<Trace[]> {
    const result = await this.pool.query<{ document: unknown }>(
      "SELECT document FROM traces ORDER BY created_at ASC, trace_id ASC",
    );
    return result.rows.map((row) => readStoredTrace(row.document));
  }

  async listTraceRecords(): Promise<Array<StoredDocument<Trace>>> {
    const result = await this.pool.query<{ document: unknown; created_at: Date | string }>(
      "SELECT document, created_at FROM traces ORDER BY created_at ASC, trace_id ASC",
    );
    return result.rows.map((row) => ({
      created_at: timestampToIso(row.created_at, "traces.created_at"),
      document: readStoredTrace(row.document),
    }));
  }

  async listTracesByRun(runId: string): Promise<Trace[]> {
    const result = await this.pool.query<{ document: unknown }>(
      `SELECT document FROM traces
       WHERE run_id = $1
       ORDER BY created_at ASC, trace_id ASC`,
      [runId],
    );
    return result.rows.map((row) => readStoredTrace(row.document));
  }

  /** First-insert time for a run. Tests use this to show an update does not move the row. */
  async runCreatedAtForTests(runId: string): Promise<string | undefined> {
    const result = await this.pool.query<{ created_at: Date }>(
      "SELECT created_at FROM runs WHERE run_id = $1",
      [runId],
    );
    const row = result.rows[0];
    return row ? row.created_at.toISOString() : undefined;
  }

  async upsertImportedRun(run: Run, createdAt: string): Promise<"inserted" | "updated"> {
    const prepared = prepareImportedRun(run, createdAt);
    const existing = await this.getRun(prepared.run.run_id);
    await this.pool.query(
      `INSERT INTO runs (run_id, agent_id, document, created_at)
       VALUES ($1, $2, $3::jsonb, $4::timestamptz)
       ON CONFLICT (run_id) DO UPDATE
       SET agent_id = EXCLUDED.agent_id,
           document = EXCLUDED.document`,
      [prepared.run.run_id, prepared.run.agent_id, JSON.stringify(prepared.run), prepared.createdAt],
    );
    return existing ? "updated" : "inserted";
  }

  async upsertImportedTrace(trace: Trace, createdAt: string): Promise<"inserted" | "updated"> {
    const prepared = prepareImportedTrace(trace, createdAt);
    const existing = await this.getTrace(prepared.trace.trace_id);
    await this.pool.query(
      `INSERT INTO traces (trace_id, run_id, agent_id, document, started_at, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, $6::timestamptz)
       ON CONFLICT (trace_id) DO UPDATE
       SET run_id = EXCLUDED.run_id,
           agent_id = EXCLUDED.agent_id,
           document = EXCLUDED.document,
           started_at = EXCLUDED.started_at`,
      [
        prepared.trace.trace_id,
        prepared.trace.run_id,
        prepared.trace.agent_id,
        JSON.stringify(prepared.trace),
        prepared.trace.started_at,
        prepared.createdAt,
      ],
    );
    return existing ? "updated" : "inserted";
  }

  /** Deletes cursors, then every trace, then every run, in the current search_path. Not an HTTP route. */
  async deleteAllRunsAndTraces(): Promise<{ runs: number; traces: number }> {
    await this.pool.query("DELETE FROM otel_pull_cursors");
    const traces = await this.pool.query("DELETE FROM traces");
    const runs = await this.pool.query("DELETE FROM runs");
    return { traces: traces.rowCount ?? 0, runs: runs.rowCount ?? 0 };
  }

  async getOtelPullCursor(agentId: string, source: OtelMockChannel): Promise<string | undefined> {
    const result = await this.pool.query<{ last_pull_at: Date | string }>(
      "SELECT last_pull_at FROM otel_pull_cursors WHERE agent_id = $1 AND source = $2",
      [agentId, source],
    );
    const row = result.rows[0];
    return row ? timestampToIso(row.last_pull_at, "otel_pull_cursors.last_pull_at") : undefined;
  }

  async setOtelPullCursor(agentId: string, source: OtelMockChannel, lastPullAt: string): Promise<void> {
    const at = assertUtcTimestamp(lastPullAt, "last_pull_at");
    await this.pool.query(
      `INSERT INTO otel_pull_cursors (agent_id, source, last_pull_at)
       VALUES ($1, $2, $3::timestamptz)
       ON CONFLICT (agent_id, source) DO UPDATE
       SET last_pull_at = EXCLUDED.last_pull_at`,
      [agentId, source, at],
    );
  }

  /** Deletes every run and trace in the current search_path. Tests only. Not an HTTP route. */
  async deleteAllRowsForTests(): Promise<void> {
    await this.deleteAllRunsAndTraces();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
