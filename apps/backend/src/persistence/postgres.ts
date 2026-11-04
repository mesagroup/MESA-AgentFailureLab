import type { Run, Trace } from "@mesa/shared";
import pg from "pg";
import { applyMigrations, postgresPoolConfig, quoteIdent } from "../agents/postgres.js";
import { assertRun, assertTrace, readStoredRun, readStoredTrace, type RunStore } from "./store.js";

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

  async getTrace(traceId: string): Promise<Trace | undefined> {
    const result = await this.pool.query<{ document: unknown }>(
      "SELECT document FROM traces WHERE trace_id = $1",
      [traceId],
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

  /** Deletes every run and trace in the current search_path. Tests only. Not an HTTP route. */
  async deleteAllRowsForTests(): Promise<void> {
    await this.pool.query("DELETE FROM traces");
    await this.pool.query("DELETE FROM runs");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}
