import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Agent, Run, Trace } from "@mesa/shared";
import { validateRun, validateTrace } from "@mesa/shared/validate";
import pg from "pg";
import { PostgresAgentStore, isRenderPostgresUrl, postgresPoolConfig, quoteIdent } from "../src/agents/postgres.js";
import { LIBRARY_AGENT_ID, REFERENCE_AGENT_ID } from "../src/agents/store.js";
import { PostgresRunStore } from "../src/persistence/postgres.js";
import {
  exportStores,
  importPersistence,
  resetKeepingSeed,
  type PersistenceExport,
} from "../src/persistence/transfer.js";
import { loadReferenceAgent } from "../src/reference-agent.js";

/**
 * Postgres checks run only when TEST_DATABASE_URL points at a disposable database.
 * They are skipped in CI. The suite writes schema `mesa_transfer_test` and deletes
 * rows there. It does not read or write `public.agents`, `public.runs`, or `public.traces`.
 * A host containing `.render.com` is refused before any connection.
 */
const databaseUrl = process.env.TEST_DATABASE_URL?.trim() ?? "";
const TEST_SCHEMA = "mesa_transfer_test";

function readFixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../fixtures/jury/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function baselineRun(): Run {
  const result = validateRun(readFixture("baseline-run.json"));
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("baseline run");
  return result.value;
}

function baselineTrace(): Trace {
  const result = validateTrace(readFixture("baseline-trace.json"));
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("baseline trace");
  return result.value;
}

function externalAgent(agentId: string, createdAt: string): Agent {
  const agent = loadReferenceAgent();
  return {
    ...agent,
    agent_id: agentId,
    name: `External ${agentId}`,
    description: `Postgres transfer agent ${agentId}.`,
    created_at: createdAt,
    updated_at: createdAt,
    instance: {
      kind: "external",
      base_url: "http://127.0.0.1:3002",
      runtime: "grok",
    },
  };
}

describe(
  "Postgres backup, import, and reset",
  { skip: databaseUrl === "" ? "TEST_DATABASE_URL is not set" : false, concurrency: false },
  () => {
    let agents: PostgresAgentStore | undefined;
    let runs: PostgresRunStore | undefined;

    before(async () => {
      if (databaseUrl === "") return;
      if (isRenderPostgresUrl(databaseUrl) || /\.render\.com\b/i.test(databaseUrl)) {
        throw new Error(
          "Refusing to run backup tests against a Render host. Point TEST_DATABASE_URL at a local database.",
        );
      }
      const admin = new pg.Pool(postgresPoolConfig(databaseUrl));
      try {
        await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdent(TEST_SCHEMA)} CASCADE`);
        await admin.query(`CREATE SCHEMA ${quoteIdent(TEST_SCHEMA)}`);
      } finally {
        await admin.end();
      }
      agents = new PostgresAgentStore(databaseUrl, { searchPath: TEST_SCHEMA });
      runs = new PostgresRunStore(databaseUrl, { searchPath: TEST_SCHEMA });
      await agents.migrate();
      await runs.migrate();
    });

    after(async () => {
      if (runs) {
        await runs.deleteAllRowsForTests();
        await runs.close();
      }
      if (agents) {
        await agents.deleteAllRowsForTests();
        await agents.close();
      }
    });

    async function empty(): Promise<{ agents: PostgresAgentStore; runs: PostgresRunStore }> {
      const agentStore = agents;
      const runStore = runs;
      assert.ok(agentStore);
      assert.ok(runStore);
      await runStore.deleteAllRunsAndTraces();
      await agentStore.deleteAllRowsForTests();
      await agentStore.seedIfMissing();
      return { agents: agentStore, runs: runStore };
    }

    it("exports the column created_at and imports it back", async () => {
      const store = await empty();
      const run = baselineRun();
      const trace = baselineTrace();
      const extra = externalAgent("pg-extra", "2022-04-04T00:00:00.000Z");
      await store.agents.upsertImported(extra);
      await store.runs.saveRun(run);
      await store.runs.saveTrace(trace);
      const column = await store.runs.runCreatedAtForTests(run.run_id);
      assert.ok(column);

      const exported = await exportStores(store.agents, store.runs, new Date("2026-11-04T15:00:00.000Z"));
      assert.equal(exported.source, "postgres");
      assert.equal(exported.created_at_source, "column");
      assert.equal(exported.runs.find((row) => row.document.run_id === run.run_id)?.created_at, column);
      assert.equal(exported.traces[0]?.created_at, (await store.runs.listTraceRecords())[0]?.created_at);
      assert.equal(exported.agents.find((agent) => agent.agent_id === extra.agent_id)?.created_at, extra.created_at);

      await store.runs.deleteAllRunsAndTraces();
      await store.agents.deleteAgentsExceptSeed();
      assert.equal(await store.runs.getRun(run.run_id), undefined);
      const imported = await importPersistence(store.agents, store.runs, exported);
      assert.equal(imported.runs.inserted, 1);
      assert.equal(imported.traces.inserted, 1);
      assert.equal(imported.agents.inserted, 1);
      assert.equal(imported.agents.updated >= 1, true);
      assert.equal(await store.runs.runCreatedAtForTests(run.run_id), column);
      assert.deepEqual(await store.runs.getRun(run.run_id), run);
      assert.deepEqual(await store.runs.getTrace(trace.trace_id), trace);
      assert.equal((await store.agents.get(extra.agent_id))?.name, extra.name);

      const inspect = new pg.Pool({
        ...postgresPoolConfig(databaseUrl),
        options: `-c search_path=${quoteIdent(TEST_SCHEMA)}`,
      });
      try {
        const schema = await inspect.query<{ current: string }>("SELECT current_schema() AS current");
        assert.equal(schema.rows[0]?.current, TEST_SCHEMA);
        const regs = await inspect.query<{ agents: string | null; runs: string | null; traces: string | null }>(
          `SELECT to_regclass('public.agents')::text AS agents,
                  to_regclass('public.runs')::text AS runs,
                  to_regclass('public.traces')::text AS traces`,
        );
        assert.equal(regs.rows[0]?.agents ?? null, null);
        assert.equal(regs.rows[0]?.runs ?? null, null);
        assert.equal(regs.rows[0]?.traces ?? null, null);
      } finally {
        await inspect.end();
      }
    });

    it("keeps the stored created_at when the same file is imported again", async () => {
      const store = await empty();
      const run = baselineRun();
      const trace = baselineTrace();
      const older: Run = { ...run, run_id: "run-older", task_id: "T1", trace_ids: [], duration_ms: 3 };
      await store.runs.upsertImportedRun(older, "2020-01-01T00:00:00.000Z");
      await store.runs.upsertImportedRun(run, "2024-08-08T00:00:00.000Z");
      await store.runs.upsertImportedTrace(trace, "2024-08-08T00:00:01.000Z");
      const extra = externalAgent("pg-keep", "2023-03-03T00:00:00.000Z");
      await store.agents.upsertImported(extra);

      const exported = await exportStores(store.agents, store.runs);
      assert.deepEqual(
        exported.runs.map((row) => row.document.run_id),
        ["run-older", run.run_id],
      );
      const firstCreated = await store.runs.runCreatedAtForTests(run.run_id);
      assert.equal(firstCreated, "2024-08-08T00:00:00.000Z");

      const again = await importPersistence(store.agents, store.runs, exported);
      assert.equal(again.runs.inserted, 0);
      assert.equal(again.runs.updated, 2);
      assert.equal(again.traces.updated, 1);
      assert.equal(again.agents.updated >= 1, true);
      assert.equal(await store.runs.runCreatedAtForTests(run.run_id), firstCreated);
      assert.deepEqual(await store.runs.getRun(run.run_id), run);

      const moved = structuredClone(exported) satisfies PersistenceExport;
      const movedRun = moved.runs.find((row) => row.document.run_id === run.run_id);
      assert.ok(movedRun);
      movedRun.created_at = "2030-01-01T00:00:00.000Z";
      movedRun.document = { ...movedRun.document, duration_ms: 77 };
      const movedAgent = moved.agents.find((agent) => agent.agent_id === extra.agent_id);
      assert.ok(movedAgent);
      movedAgent.created_at = "2030-02-02T00:00:00.000Z";
      movedAgent.name = "Kept created_at";
      movedAgent.updated_at = "2026-02-02T00:00:00.000Z";
      await importPersistence(store.agents, store.runs, moved);

      assert.equal(await store.runs.runCreatedAtForTests(run.run_id), firstCreated);
      assert.equal((await store.runs.getRun(run.run_id))?.duration_ms, 77);
      assert.deepEqual(
        (await store.runs.listRuns()).map((item) => item.run_id),
        ["run-older", run.run_id],
      );
      const kept = await store.agents.get(extra.agent_id);
      assert.equal(kept?.created_at, extra.created_at);
      assert.equal(kept?.name, "Kept created_at");
      assert.equal(kept?.updated_at, "2026-02-02T00:00:00.000Z");
      const traceCreated = (await store.runs.listTraceRecords())[0]?.created_at;
      assert.equal(traceCreated, "2024-08-08T00:00:01.000Z");
    });

    it("resets runs, traces, and extra agents while keeping an edited seed", async () => {
      const store = await empty();
      const seed = await store.agents.get(REFERENCE_AGENT_ID);
      assert.ok(seed);
      await store.agents.replace(REFERENCE_AGENT_ID, { ...seed, name: "Edited seed" });
      await store.agents.upsertImported(externalAgent("pg-wipe", "2021-01-01T00:00:00.000Z"));
      await store.runs.upsertImportedRun(baselineRun(), "2024-01-01T00:00:00.000Z");
      await store.runs.upsertImportedTrace(baselineTrace(), "2024-01-01T00:00:01.000Z");

      const counts = await resetKeepingSeed(store.agents, store.runs);
      assert.equal(counts.seed[REFERENCE_AGENT_ID], "kept");
      assert.equal(counts.seed[LIBRARY_AGENT_ID], "kept");
      assert.equal(counts.agents_deleted, 1);
      assert.equal(counts.runs_deleted, 1);
      assert.equal(counts.traces_deleted, 1);
      assert.deepEqual(
        (await store.agents.list()).map((agent) => agent.agent_id),
        [REFERENCE_AGENT_ID, LIBRARY_AGENT_ID],
      );
      const kept = await store.agents.get(REFERENCE_AGENT_ID);
      assert.equal(kept?.name, "Edited seed");
      assert.equal(kept?.created_at, seed.created_at);
      assert.deepEqual(await store.runs.listRuns(), []);
      assert.deepEqual(await store.runs.listTraces(), []);

      await store.agents.deleteAllRowsForTests();
      const inserted = await resetKeepingSeed(store.agents, store.runs);
      assert.equal(inserted.seed[REFERENCE_AGENT_ID], "inserted");
      assert.equal(inserted.seed[LIBRARY_AGENT_ID], "inserted");
      assert.equal(inserted.agents_deleted, 0);
      assert.equal((await store.agents.get(REFERENCE_AGENT_ID))?.name, "Reference shop assistant");
      assert.equal((await store.agents.get(LIBRARY_AGENT_ID))?.name, "Library desk");
      assert.equal((await store.agents.list()).length, 2);
    });
  },
);
