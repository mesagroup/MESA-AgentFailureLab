import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent } from "@mesa/shared";
import { validateAgent } from "@mesa/shared/validate";
import pg from "pg";
import {
  AgentConflictError,
  AgentNotFoundError,
  ProtectedAgentError,
  agentFromCreate,
  agentFromReplace,
  importedAgent,
  isSeededAgentId,
  rawAgentId,
  readableStoredAgents,
  readStoredAgent,
  seedFixtures,
  keptSeedDocument,
  seedRewriteReason,
  storedTimestamp,
  warnSeedRewritten,
  type AgentStore,
  type SeedReport,
  type SeedResult,
} from "./store.js";

const MIGRATION_TABLE = "schema_migrations";

/** Directory of numbered SQL files. Resolved from this module so dist and tsx agree. */
export function migrationsDirectory(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
}

export function listMigrationFiles(dir = migrationsDirectory()): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));
}

/** True when the URL host is a public Render Postgres hostname. Tests refuse these URLs. */
export function isRenderPostgresUrl(connectionString: string): boolean {
  return /@[^/?#]*\.render\.com(?::\d+)?(?:\/|\?|$)/i.test(connectionString);
}

/**
 * Pool settings for a Postgres URL.
 *
 * Render's internal URL (`fromDatabase` property `connectionString`) is a
 * private-network host. It has no `.render.com` suffix and no `sslmode`.
 * TLS is not required on that path, so the string is passed through. Compose
 * (`postgres://mesa:mesa@mesa-postgres:5432/mesa`) takes the same path.
 *
 * The external URL requires TLS. Render rejects `sslmode=disable` on it, and
 * Node does not trust the certificate by default. A `.render.com` host, or
 * any URL with `sslmode=require` (the external URL, or internal TLS opted
 * in), uses TLS with `rejectUnauthorized: false`. `sslmode` is removed so
 * node-postgres does not turn `require` into CA verification. Internal
 * certificates are self-signed, so `verify-ca` and `verify-full` are not used.
 */
export function postgresPoolConfig(connectionString: string): pg.PoolConfig {
  const renderHost = isRenderPostgresUrl(connectionString);
  const requireSsl = /(?:\?|&)sslmode=require(?:&|$)/i.test(connectionString);
  const base: pg.PoolConfig = {
    max: 5,
    connectionTimeoutMillis: 10_000,
  };
  if (!renderHost && !requireSsl) {
    return { ...base, connectionString };
  }
  const stripped = connectionString
    .replace(/([?&])sslmode=require&/i, "$1")
    .replace(/([?&])sslmode=require$/i, "")
    .replace(/\?$/, "");
  return {
    ...base,
    connectionString: stripped,
    ssl: { rejectUnauthorized: false },
  };
}

export function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid Postgres identifier ${name}.`);
  }
  return name;
}

/**
 * SQL files are LF in git. A Windows checkout may hand the runner CRLF, and a
 * copied file may start with a BOM. Postgres accepts either ending, but one
 * normalized form keeps the script identical on both.
 */
export function normalizeMigrationSql(sql: string): string {
  return sql.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Apply every pending `migrations/*.sql` file in name order.
 * Each file runs in its own transaction. A file already recorded in
 * `schema_migrations` is skipped. Shipped files stay unchanged; add the next
 * numbered file instead. Agent and run stores both call this.
 */
export async function applyMigrations(pool: pg.Pool, dir = migrationsDirectory()): Promise<void> {
  const files = listMigrationFiles(dir);
  if (files.length === 0) {
    throw new Error(`No SQL migrations found in ${dir}.`);
  }
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    for (const file of files) {
      const seen = await client.query(`SELECT 1 FROM ${MIGRATION_TABLE} WHERE version = $1`, [file]);
      if ((seen.rowCount ?? 0) > 0) continue;
      const sql = normalizeMigrationSql(readFileSync(join(dir, file), "utf8"));
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          `INSERT INTO ${MIGRATION_TABLE} (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
          [file],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    client.release();
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export interface PostgresAgentStoreOptions {
  /**
   * Libpq search_path for this pool. Tests use a private schema so they do not
   * write the public `agents` table. Production leaves this unset.
   */
  searchPath?: string;
}

/** Postgres-backed agent store. The full Agent document is one jsonb column. */
export class PostgresAgentStore implements AgentStore {
  readonly kind = "postgres" as const;
  private readonly pool: pg.Pool;
  private closed = false;

  constructor(connectionString: string, options: PostgresAgentStoreOptions = {}) {
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

  async list(): Promise<Agent[]> {
    const result = await this.pool.query<{ document: unknown }>(
      "SELECT document FROM agents ORDER BY created_at ASC, agent_id ASC",
    );
    return readableStoredAgents(result.rows.map((row) => row.document));
  }

  async get(agentId: string): Promise<Agent | undefined> {
    const raw = await this.readRaw(agentId);
    if (raw === undefined) return undefined;
    return readStoredAgent(raw);
  }

  async create(body: unknown): Promise<Agent> {
    const agent = agentFromCreate(body);
    try {
      await this.pool.query(
        `INSERT INTO agents (agent_id, document, created_at, updated_at)
         VALUES ($1, $2::jsonb, $3::timestamptz, $4::timestamptz)`,
        [agent.agent_id, JSON.stringify(agent), agent.created_at, agent.updated_at],
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new AgentConflictError(agent.agent_id);
      throw error;
    }
    return structuredClone(agent);
  }

  async replace(agentId: string, body: unknown): Promise<Agent> {
    const existing = await this.readRaw(agentId);
    if (existing === undefined) throw new AgentNotFoundError(agentId);
    const agent = agentFromReplace(
      { created_at: storedTimestamp(existing, "created_at", new Date().toISOString()) },
      agentId,
      body,
    );
    const result = await this.pool.query(
      `UPDATE agents
       SET document = $2::jsonb,
           created_at = $3::timestamptz,
           updated_at = $4::timestamptz
       WHERE agent_id = $1`,
      [agent.agent_id, JSON.stringify(agent), agent.created_at, agent.updated_at],
    );
    if ((result.rowCount ?? 0) === 0) throw new AgentNotFoundError(agentId);
    return structuredClone(agent);
  }

  async delete(agentId: string): Promise<void> {
    if (isSeededAgentId(agentId)) throw new ProtectedAgentError(agentId);
    const result = await this.pool.query("DELETE FROM agents WHERE agent_id = $1", [agentId]);
    if ((result.rowCount ?? 0) === 0) throw new AgentNotFoundError(agentId);
  }

  async seedIfMissing(): Promise<SeedReport> {
    const report: Record<string, SeedResult> = {};
    for (const fixture of seedFixtures()) {
      report[fixture.agent_id] = await this.seedOne(fixture);
    }
    return report;
  }

  async upsertImported(agent: Agent): Promise<"inserted" | "updated"> {
    const valid = importedAgent(agent);
    const existing = await this.readRaw(valid.agent_id);
    if (existing === undefined) {
      try {
        await this.pool.query(
          `INSERT INTO agents (agent_id, document, created_at, updated_at)
           VALUES ($1, $2::jsonb, $3::timestamptz, $4::timestamptz)`,
          [valid.agent_id, JSON.stringify(valid), valid.created_at, valid.updated_at],
        );
        return "inserted";
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    const current = existing ?? (await this.readRaw(valid.agent_id));
    if (current === undefined) throw new AgentNotFoundError(valid.agent_id);
    const next = importedAgent({
      ...valid,
      created_at: storedTimestamp(current, "created_at", valid.created_at),
    });
    const result = await this.pool.query(
      `UPDATE agents
       SET document = $2::jsonb,
           updated_at = $3::timestamptz
       WHERE agent_id = $1`,
      [next.agent_id, JSON.stringify(next), next.updated_at],
    );
    if ((result.rowCount ?? 0) === 0) throw new AgentNotFoundError(valid.agent_id);
    return "updated";
  }

  async deleteAgentsExceptSeed(): Promise<number> {
    const result = await this.pool.query("DELETE FROM agents WHERE NOT (agent_id = ANY($1::text[]))", [
      seedFixtures().map((agent) => agent.agent_id),
    ]);
    return result.rowCount ?? 0;
  }

  /** Deletes every agent row in the current search_path, including the seed. Tests only. */
  async deleteAllRowsForTests(): Promise<void> {
    await this.pool.query("DELETE FROM agents");
  }

  /** Insert or replace one document without validation. Tests plant a stale row with this. */
  async putRawForTests(document: unknown): Promise<void> {
    const agentId = rawAgentId(document);
    const createdAt = storedTimestamp(document, "created_at", new Date(0).toISOString());
    const updatedAt = storedTimestamp(document, "updated_at", createdAt);
    await this.pool.query(
      `INSERT INTO agents (agent_id, document, created_at, updated_at)
       VALUES ($1, $2::jsonb, $3::timestamptz, $4::timestamptz)
       ON CONFLICT (agent_id) DO UPDATE
         SET document = EXCLUDED.document,
             created_at = EXCLUDED.created_at,
             updated_at = EXCLUDED.updated_at`,
      [agentId, JSON.stringify(document), createdAt, updatedAt],
    );
  }

  private async readRaw(agentId: string): Promise<unknown | undefined> {
    const result = await this.pool.query<{ document: unknown }>(
      "SELECT document FROM agents WHERE agent_id = $1",
      [agentId],
    );
    return result.rows[0]?.document;
  }

  private async seedOne(fixture: Agent): Promise<SeedResult> {
    const stored = await this.readRaw(fixture.agent_id);
    if (stored === undefined) {
      const inserted = await this.pool.query(
        `INSERT INTO agents (agent_id, document, created_at, updated_at)
         VALUES ($1, $2::jsonb, $3::timestamptz, $4::timestamptz)
         ON CONFLICT (agent_id) DO NOTHING`,
        [fixture.agent_id, JSON.stringify(fixture), fixture.created_at, fixture.updated_at],
      );
      if ((inserted.rowCount ?? 0) > 0) return "inserted";
      const raced = await this.readRaw(fixture.agent_id);
      if (raced === undefined) throw new AgentNotFoundError(fixture.agent_id);
      return this.rewriteSeedIfNeeded(raced, fixture);
    }
    return this.rewriteSeedIfNeeded(stored, fixture);
  }

  private async rewriteSeedIfNeeded(stored: unknown, fixture: Agent): Promise<SeedResult> {
    const reason = seedRewriteReason(stored, fixture);
    if (reason === undefined) {
    const parsed = validateAgent(structuredClone(stored));
    if (!parsed.ok) return "kept";
    const kept = keptSeedDocument(parsed.value, fixture);
    if (!kept) return "kept";
    if (kept.healed) warnSeedRewritten(fixture.agent_id, "production loopback endpoints replaced from this process");
    const filled = await this.pool.query(
      `UPDATE agents
       SET document = $2::jsonb
       WHERE agent_id = $1`,
      [kept.agent.agent_id, JSON.stringify(kept.agent)],
    );
    if ((filled.rowCount ?? 0) === 0) throw new AgentNotFoundError(fixture.agent_id);
    return kept.healed ? "refreshed" : "backfilled";
    }
    warnSeedRewritten(fixture.agent_id, reason);
    const updated = await this.pool.query(
      `UPDATE agents
       SET document = $2::jsonb,
           created_at = $3::timestamptz,
           updated_at = $4::timestamptz
       WHERE agent_id = $1`,
      [fixture.agent_id, JSON.stringify(fixture), fixture.created_at, fixture.updated_at],
    );
    if ((updated.rowCount ?? 0) > 0) return "refreshed";
    await this.pool.query(
      `INSERT INTO agents (agent_id, document, created_at, updated_at)
       VALUES ($1, $2::jsonb, $3::timestamptz, $4::timestamptz)
       ON CONFLICT (agent_id) DO UPDATE
         SET document = EXCLUDED.document,
             created_at = EXCLUDED.created_at,
             updated_at = EXCLUDED.updated_at`,
      [fixture.agent_id, JSON.stringify(fixture), fixture.created_at, fixture.updated_at],
    );
    return "inserted";
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}
