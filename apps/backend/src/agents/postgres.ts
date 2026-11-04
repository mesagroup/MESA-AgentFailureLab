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
  REFERENCE_AGENT_ID,
  agentFromCreate,
  agentFromReplace,
  referenceSeed,
  type AgentStore,
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

/**
 * Pool settings for a Postgres URL.
 * Render's public URL sets `sslmode=require` and presents a certificate Node
 * does not trust by default. Those URLs use TLS without CA verification.
 * Local URLs, including Compose, are left unchanged.
 */
export function postgresPoolConfig(connectionString: string): pg.PoolConfig {
  const renderHost = /@[^/?#]*\.render\.com(?::\d+)?(?:\/|\?|$)/i.test(connectionString);
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

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid Postgres identifier ${name}.`);
  }
  return name;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function readStoredAgent(value: unknown): Agent {
  const result = validateAgent(value);
  if (!result.ok) {
    throw new Error(`Stored agent failed schema: ${result.errors.join("; ")}`);
  }
  return structuredClone(result.value);
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
    const dir = migrationsDirectory();
    const files = listMigrationFiles(dir);
    if (files.length === 0) {
      throw new Error(`No SQL migrations found in ${dir}.`);
    }
    const client = await this.pool.connect();
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
        const sql = readFileSync(join(dir, file), "utf8");
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

  async list(): Promise<Agent[]> {
    const result = await this.pool.query<{ document: unknown }>(
      "SELECT document FROM agents ORDER BY created_at ASC, agent_id ASC",
    );
    return result.rows.map((row) => readStoredAgent(row.document));
  }

  async get(agentId: string): Promise<Agent | undefined> {
    const result = await this.pool.query<{ document: unknown }>(
      "SELECT document FROM agents WHERE agent_id = $1",
      [agentId],
    );
    const row = result.rows[0];
    return row ? readStoredAgent(row.document) : undefined;
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
    const existing = await this.get(agentId);
    if (!existing) throw new AgentNotFoundError(agentId);
    const agent = agentFromReplace(existing, agentId, body);
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
    if (agentId === REFERENCE_AGENT_ID) throw new ProtectedAgentError();
    const result = await this.pool.query("DELETE FROM agents WHERE agent_id = $1", [agentId]);
    if ((result.rowCount ?? 0) === 0) throw new AgentNotFoundError(agentId);
  }

  async seedIfMissing(): Promise<void> {
    const agent = referenceSeed();
    await this.pool.query(
      `INSERT INTO agents (agent_id, document, created_at, updated_at)
       VALUES ($1, $2::jsonb, $3::timestamptz, $4::timestamptz)
       ON CONFLICT (agent_id) DO NOTHING`,
      [agent.agent_id, JSON.stringify(agent), agent.created_at, agent.updated_at],
    );
  }

  /** Deletes every agent row in the current search_path, including the seed. Tests only. */
  async deleteAllRowsForTests(): Promise<void> {
    await this.pool.query("DELETE FROM agents");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}
