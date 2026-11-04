import { MemoryAgentStore, type AgentStore } from "./store.js";
import { PostgresAgentStore } from "./postgres.js";

/** `DATABASE_URL` selects Postgres. An empty or missing value stays in memory. */
export function agentStoreKind(env: NodeJS.ProcessEnv): AgentStore["kind"] {
  const url = env.DATABASE_URL?.trim() ?? "";
  return url === "" ? "memory" : "postgres";
}

/**
 * Open the agent store and, for Postgres, apply SQL migrations and seed
 * `reference-shop` when that id is absent. The memory store seeds in its constructor.
 */
export async function openAgentStore(env: NodeJS.ProcessEnv = process.env): Promise<AgentStore> {
  const url = env.DATABASE_URL?.trim() ?? "";
  if (url === "") return new MemoryAgentStore();
  const store = new PostgresAgentStore(url);
  try {
    await store.migrate();
    await store.seedIfMissing();
  } catch (error) {
    await store.close();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to open the agent store. Check DATABASE_URL and that Postgres is reachable. ${message}`,
    );
  }
  return store;
}
