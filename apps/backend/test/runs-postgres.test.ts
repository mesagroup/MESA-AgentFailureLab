import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Run, Trace } from "@mesa/shared";
import { validateRun, validateTrace } from "@mesa/shared/validate";
import pg from "pg";
import { postgresPoolConfig, quoteIdent } from "../src/agents/postgres.js";
import { buildApp } from "../src/app.js";
import { PostgresRunStore } from "../src/persistence/postgres.js";
import { ContractError } from "../src/persistence/store.js";
import { diagnosis, diagnosisRun, diagnosisTrace } from "./diagnosis-fixtures.js";

/**
 * Postgres checks run only when TEST_DATABASE_URL points at a disposable database.
 * They are skipped in CI. The suite writes schema `mesa_run_test` and deletes
 * rows there. It does not read or write `public.runs` or `public.traces`.
 * A host containing `.render.com` is refused before any connection.
 */
const databaseUrl = process.env.TEST_DATABASE_URL?.trim() ?? "";
const TEST_SCHEMA = "mesa_run_test";

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

describe(
  "Postgres run and trace store",
  { skip: databaseUrl === "" ? "TEST_DATABASE_URL is not set" : false, concurrency: false },
  () => {
  let store: PostgresRunStore | undefined;

  before(async () => {
    if (databaseUrl === "") return;
    if (/\.render\.com\b/i.test(databaseUrl)) {
      throw new Error("Refusing to run run/trace store tests against a Render host. Point TEST_DATABASE_URL at a local database.");
    }
    const admin = new pg.Pool(postgresPoolConfig(databaseUrl));
    try {
      // This suite owns the schema. Rebuild it so a local rerun still applies
      // 002 and 003 from empty, then the second migrate proves they are skipped.
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdent(TEST_SCHEMA)} CASCADE`);
      await admin.query(`CREATE SCHEMA ${quoteIdent(TEST_SCHEMA)}`);
    } finally {
      await admin.end();
    }
    store = new PostgresRunStore(databaseUrl, { searchPath: TEST_SCHEMA });
    await store.migrate();
    await store.migrate();
    await store.deleteAllRowsForTests();
  });

  after(async () => {
    if (!store) return;
    await store.deleteAllRowsForTests();
    await store.close();
  });

  it("applies each migration once and creates the lookup indexes", async () => {
    const runs = store;
    assert.ok(runs);
    await runs.migrate();

    const inspect = new pg.Pool({
      ...postgresPoolConfig(databaseUrl),
      options: `-c search_path=${quoteIdent(TEST_SCHEMA)}`,
    });
    try {
      const schema = await inspect.query<{ current: string }>("SELECT current_schema() AS current");
      assert.equal(schema.rows[0]?.current, TEST_SCHEMA);

      const versions = await inspect.query<{ version: string }>(
        "SELECT version FROM schema_migrations ORDER BY version ASC",
      );
      assert.deepEqual(
        versions.rows.map((row) => row.version),
        ["001_agents.sql", "002_runs.sql", "003_traces.sql", "004_otel_pull_cursors.sql"],
      );

      const indexes = await inspect.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = current_schema()
           AND tablename IN ('runs', 'traces')
         ORDER BY indexname ASC`,
      );
      assert.deepEqual(
        indexes.rows.map((row) => row.indexname),
        [
          "runs_agent_id_created_at_idx",
          "runs_created_at_run_id_idx",
          "runs_pkey",
          "traces_created_at_trace_id_idx",
          "traces_pkey",
          "traces_run_id_created_at_idx",
        ],
      );
    } finally {
      await inspect.end();
    }
  });

  it("round-trips a run with its traces across a new pool", async () => {
    const runs = store;
    assert.ok(runs);
    const run = baselineRun();
    const trace = baselineTrace();
    const other: Run = {
      ...run,
      run_id: "run-other-agent",
      agent_id: "other-agent",
      trace_ids: [],
      duration_ms: 10,
    };
    const otherTrace: Trace = {
      ...trace,
      trace_id: "trace-other-agent",
      run_id: other.run_id,
      agent_id: other.agent_id,
    };

    const bad = { ...run, run_id: "run-bad", phase: "sideways" } as unknown as Run;
    await assert.rejects(runs.saveRun(bad), (error: unknown) => {
      assert.ok(error instanceof ContractError);
      assert.match(error.message, /run-bad failed schema/);
      return true;
    });
    assert.equal(await runs.getRun("run-bad"), undefined);

    await runs.saveRun(run);
    await runs.saveTrace(trace);
    await runs.saveRun(other);
    await runs.saveTrace(otherTrace);
    const createdAt = await runs.runCreatedAtForTests(run.run_id);
    assert.ok(createdAt);

    const rewritten = await runs.saveRun({ ...run, duration_ms: (run.duration_ms ?? 0) + 5 });
    assert.equal(rewritten.duration_ms, (run.duration_ms ?? 0) + 5);
    assert.equal(await runs.runCreatedAtForTests(run.run_id), createdAt);

    assert.deepEqual(
      (await runs.listRunsByAgent("reference-shop")).map((item) => item.run_id),
      [run.run_id],
    );
    assert.deepEqual(await runs.listTracesByRun(run.run_id), [trace]);
    assert.equal((await runs.listRuns()).length, 2);
    assert.equal((await runs.listTraces()).length, 2);

    const restarted = new PostgresRunStore(databaseUrl, { searchPath: TEST_SCHEMA });
    try {
      await restarted.migrate();
      assert.deepEqual(await restarted.getRun(run.run_id), { ...run, duration_ms: (run.duration_ms ?? 0) + 5 });
      assert.deepEqual(await restarted.getTrace(trace.trace_id), trace);
      assert.equal((await restarted.getTrace(trace.trace_id))?.diagnosis, null);
      assert.deepEqual(
        (await restarted.listTracesByRun(run.run_id)).map((item) => item.trace_id),
        [trace.trace_id],
      );
      assert.equal((await restarted.listRunsByAgent("other-agent"))[0]?.run_id, other.run_id);
      assert.equal(await restarted.runCreatedAtForTests(run.run_id), createdAt);
    } finally {
      await restarted.close();
    }
  });

  it("serves the same run and trace routes against Postgres", async () => {
    const runs = store;
    assert.ok(runs);
    const run = baselineRun();
    const trace = baselineTrace();
    const app = buildApp({ logger: false, store: runs });
    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      assert.equal(health.json().run_store, "postgres");

      const listed = await app.inject({ method: "GET", url: "/runs" });
      assert.equal(listed.statusCode, 200);
      const snapshot = listed.json();
      const body = snapshot.runs as Run[];
      const stored = body.find((item) => item.run_id === run.run_id);
      assert.ok(stored);
      assert.equal(stored.phase, "baseline");
      assert.equal(stored.injection_plan, null);
      assert.equal(Object.hasOwn(stored, "created_at"), false);
      const link = snapshot.trace_links.find((item: { run_id: string }) => item.run_id === run.run_id);
      assert.equal(link.first_trace_id, trace.trace_id);
      assert.equal(link.traces[0].outcome.verifier.passed, true);
      assert.equal(snapshot.counts.scope, "harness_session");

      const one = await app.inject({ method: "GET", url: `/runs/${run.run_id}` });
      assert.equal(one.statusCode, 200);
      assert.deepEqual(one.json(), await runs.getRun(run.run_id));

      const traces = await app.inject({ method: "GET", url: `/traces/${trace.trace_id}` });
      assert.equal(traces.statusCode, 200);
      assert.deepEqual(traces.json(), trace);
      assert.equal(traces.json().diagnosis, null);
      assert.equal(Object.hasOwn(traces.json(), "injection_plan"), false);
      assert.equal(Object.hasOwn(traces.json(), "phase"), false);

      const missing = await app.inject({ method: "GET", url: "/runs/does-not-exist" });
      assert.equal(missing.statusCode, 404);
      assert.equal(missing.json().error, "not_found");
    } finally {
      await app.close();
    }
  });
  it("persists diagnosis across pools and atomically rejects stale updates", async () => {
    const runs = store;
    assert.ok(runs);
    const run = diagnosisRun();
    const trace = diagnosisTrace();
    await runs.saveRun(run);
    await runs.saveTrace(trace);
    const beforeRecords = await runs.listTraceRecords();
    const createdAt = beforeRecords.find(row => row.document.trace_id === trace.trace_id)?.created_at;
    const app = buildApp({ logger: false, store: runs, diagnosis: {
      baseUrl: "http://offline-agentservice.test",
      fetchImpl: async () => Response.json({ ...trace, diagnosis: diagnosis() }),
    } });
    const restarted = new PostgresRunStore(databaseUrl, { searchPath: TEST_SCHEMA });
    try {
      const result = await app.inject({ method: "POST", url: `/traces/${trace.trace_id}/diagnose` });
      assert.equal(result.statusCode, 200);
      assert.deepEqual(await restarted.getTrace(trace.trace_id), { ...trace, diagnosis: diagnosis() });
      assert.deepEqual(await restarted.getRun(run.run_id), run);
      assert.equal((await restarted.listTraceRecords()).find(row => row.document.trace_id === trace.trace_id)?.created_at, createdAt);
      // A stale snapshot cannot overwrite the diagnosis saved by another pool.
      assert.equal(await restarted.saveDiagnosis(trace, { ...diagnosis(), cause: "stale writer" }), undefined);
      await runs.saveTrace(trace);
      const writes = await Promise.all([
        runs.saveDiagnosis(trace, diagnosis()),
        restarted.saveDiagnosis(trace, { ...diagnosis(), cause: "competing writer" }),
      ]);
      assert.equal(writes.filter(Boolean).length, 1);
      assert.deepEqual(await restarted.getTrace(trace.trace_id), writes.find(Boolean));
      const current = await runs.getTrace(trace.trace_id);
      assert.ok(current);
      await assert.rejects(runs.saveDiagnosis(current, { ...diagnosis(), confidence: 2 }));
      assert.deepEqual(await restarted.getTrace(trace.trace_id), current);
    } finally {
      await app.close();
      await restarted.close();
    }
  });
});
