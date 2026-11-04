import { MemoryStore, type RunStore } from "./memory.js";
import { PostgresRunStore } from "./postgres.js";

/** `DATABASE_URL` selects Postgres. An empty or missing value stays in memory. */
export function runStoreKind(env: NodeJS.ProcessEnv): RunStore["kind"] {
  const url = env.DATABASE_URL?.trim() ?? "";
  return url === "" ? "memory" : "postgres";
}

/**
 * Open the run and trace store. Postgres applies SQL migrations first.
 * The memory store starts empty. Runs and traces are not seeded.
 */
export async function openRunStore(env: NodeJS.ProcessEnv = process.env): Promise<RunStore> {
  const url = env.DATABASE_URL?.trim() ?? "";
  if (url === "") return new MemoryStore();
  const store = new PostgresRunStore(url);
  try {
    await store.migrate();
  } catch (error) {
    await store.close();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to open the run store. Check DATABASE_URL and that Postgres is reachable. ${message}`,
    );
  }
  return store;
}
