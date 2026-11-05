import { MemoryAgentStore, type AgentStore } from "./store.js";
import { PostgresAgentStore } from "./postgres.js";

/** `DATABASE_URL` selects Postgres. An empty or missing value stays in memory. */
export function agentStoreKind(env: NodeJS.ProcessEnv): AgentStore["kind"] {
  const url = env.DATABASE_URL?.trim() ?? "";
  return url === "" ? "memory" : "postgres";
}

export interface OpenAgentStoreOptions {
  /**
 * When false, Postgres migrates and does not insert or rewrite the demo seeds.
 * The memory store still seeds in its constructor. Default true.
 * Export uses false so a read does not write the seeds.
   */
  seed?: boolean;
}

/**
 * Open the agent store and, for Postgres, apply SQL migrations.
 * Then insert each demo seed when its id is absent, or rewrite it when the stored
 * document fails validation, is older than that fixture, or is the same age with
 * different runtime or world URLs. A newer valid row is kept, except a loopback
 * endpoint in production, which is replaced from this process's env URLs.
 * The memory store does the same in its constructor.
 */
export async function openAgentStore(
  env: NodeJS.ProcessEnv = process.env,
  options: OpenAgentStoreOptions = {},
): Promise<AgentStore> {
  const url = env.DATABASE_URL?.trim() ?? "";
  if (url === "") return new MemoryAgentStore();
  const store = new PostgresAgentStore(url);
  try {
    await store.migrate();
    if (options.seed !== false) await store.seedIfMissing();
  } catch (error) {
    await store.close();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to open the agent store. Check DATABASE_URL and that Postgres is reachable. ${message}`,
    );
  }
  return store;
}
