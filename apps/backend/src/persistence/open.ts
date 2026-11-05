import { seedDemoRunsAndTraces } from "./demo-seed.js";
import { MemoryStore, type RunStore } from "./memory.js";
import { PostgresRunStore } from "./postgres.js";

/** `DATABASE_URL` selects Postgres. An empty or missing value stays in memory. */
export function runStoreKind(env: NodeJS.ProcessEnv): RunStore["kind"] {
  const url = env.DATABASE_URL?.trim() ?? "";
  return url === "" ? "memory" : "postgres";
}

export interface OpenRunStoreOptions {
  /**
   * When false, skip demo run/trace insert. Export uses false so a read does not
   * write rows. `new MemoryStore()` is still empty until this function seeds it.
   * Default true.
   */
  seed?: boolean;
}

/**
 * Open the run and trace store. Postgres applies SQL migrations first.
 * Then insert each demo run and trace when that id is absent. Existing rows,
 * including user data, are never overwritten or deleted.
 */
export async function openRunStore(
  env: NodeJS.ProcessEnv = process.env,
  options: OpenRunStoreOptions = {},
): Promise<RunStore> {
  const url = env.DATABASE_URL?.trim() ?? "";
  if (url === "") {
    const store = new MemoryStore();
    if (options.seed !== false) await seedDemoRunsAndTraces(store);
    return store;
  }
  const store = new PostgresRunStore(url);
  try {
    await store.migrate();
    if (options.seed !== false) await seedDemoRunsAndTraces(store);
  } catch (error) {
    await store.close();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to open the run store. Check DATABASE_URL and that Postgres is reachable. ${message}`,
    );
  }
  return store;
}
