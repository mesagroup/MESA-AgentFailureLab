import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Run, Trace } from "@mesa/shared";
import { validateRun, validateTrace } from "@mesa/shared/validate";
import { buildApp } from "../src/app.js";
import { openRunStore, runStoreKind } from "../src/persistence/open.js";
import { MemoryStore } from "../src/persistence/memory.js";
import { ContractError } from "../src/persistence/store.js";

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

describe("run store selection", () => {
  it("uses memory when DATABASE_URL is missing and postgres when it is set", () => {
    assert.equal(runStoreKind({}), "memory");
    assert.equal(runStoreKind({ DATABASE_URL: "  " }), "memory");
    assert.equal(runStoreKind({ DATABASE_URL: "postgres://mesa:mesa@127.0.0.1:5432/mesa" }), "postgres");
  });

  it("opens an empty in-memory store and drops rows on a new store", async () => {
    const first = await openRunStore({}, { seed: false });
    try {
      assert.equal(first.kind, "memory");
      const run = baselineRun();
      await first.saveRun(run);
      assert.equal((await first.getRun(run.run_id))?.task_id, "T5");
      await first.close();
      await first.close();
    } finally {
      await first.close();
    }

    const second = await openRunStore({ DATABASE_URL: "   " }, { seed: false });
    try {
      assert.equal(second.kind, "memory");
      assert.equal(await second.getRun(baselineRun().run_id), undefined);
      assert.deepEqual(await second.listRuns(), []);
      assert.deepEqual(await second.listTraces(), []);
    } finally {
      await second.close();
    }
  });
});

describe("in-memory run and trace store", () => {
  it("round-trips a run with its trace and ignores later mutation", async () => {
    const store = new MemoryStore();
    const run = baselineRun();
    const trace = baselineTrace();
    const savedRun = await store.saveRun(run);
    const savedTrace = await store.saveTrace(trace);
    run.duration_ms = 99999;
    savedRun.status = "error";
    savedTrace.diagnosis = {
      category: "Security",
      cause: "mutated by the caller",
      step_id: "step-0",
      confidence: 0.5,
      evidence: [],
      proposed_fixes: [],
    };

    assert.deepEqual(await store.getRun(run.run_id), baselineRun());
    assert.deepEqual(await store.getTrace(trace.trace_id), baselineTrace());
    assert.equal((await store.getTrace(trace.trace_id))?.diagnosis, null);
    assert.deepEqual(await store.listTracesByRun(run.run_id), [baselineTrace()]);
    await store.close();
  });

  it("keeps first-save order when a row is saved again", async () => {
    const store = new MemoryStore();
    const first = baselineRun();
    const second: Run = {
      ...first,
      run_id: "run-later",
      task_id: "T1",
      trace_ids: [],
    };
    await store.saveRun(first);
    await store.saveRun(second);
    await store.saveRun({ ...first, duration_ms: (first.duration_ms ?? 0) + 1 });
    assert.deepEqual(
      (await store.listRuns()).map((run) => run.run_id),
      [first.run_id, second.run_id],
    );
    assert.equal((await store.getRun(first.run_id))?.duration_ms, (first.duration_ms ?? 0) + 1);
    await store.close();
  });

  it("lists runs by agent and traces by run", async () => {
    const store = new MemoryStore();
    const run = baselineRun();
    const trace = baselineTrace();
    const other: Run = {
      ...run,
      run_id: "run-other-agent",
      agent_id: "other-agent",
      trace_ids: [],
    };
    const otherTrace: Trace = {
      ...trace,
      trace_id: "trace-other",
      run_id: other.run_id,
      agent_id: other.agent_id,
    };
    await store.saveRun(run);
    await store.saveRun(other);
    await store.saveTrace(trace);
    await store.saveTrace(otherTrace);

    assert.deepEqual(
      (await store.listRunsByAgent("reference-shop")).map((item) => item.run_id),
      [run.run_id],
    );
    assert.deepEqual(
      (await store.listRunsByAgent("other-agent")).map((item) => item.run_id),
      [other.run_id],
    );
    assert.deepEqual(await store.listRunsByAgent("missing"), []);
    assert.deepEqual(
      (await store.listTracesByRun(run.run_id)).map((item) => item.trace_id),
      [trace.trace_id],
    );
    assert.equal((await store.listTraces()).length, 2);
    await store.close();
  });

  it("rejects an invalid run or trace and does not store it", async () => {
    const store = new MemoryStore();
    const run = baselineRun();
    const trace = baselineTrace();
    const badRun = { ...run, run_id: "run-bad", phase: "sideways" } as unknown as Run;
    const badTrace = { ...trace, trace_id: "trace-bad", diagnosis: "written-by-the-store" } as unknown as Trace;

    await assert.rejects(store.saveRun(badRun), (error: unknown) => {
      assert.ok(error instanceof ContractError);
      assert.match(error.message, /run-bad failed schema/);
      return true;
    });
    await assert.rejects(store.saveTrace(badTrace), (error: unknown) => {
      assert.ok(error instanceof ContractError);
      assert.match(error.message, /trace-bad failed schema/);
      return true;
    });
    assert.equal(await store.getRun("run-bad"), undefined);
    assert.equal(await store.getTrace("trace-bad"), undefined);
    assert.deepEqual(await store.listRuns(), []);
    await store.close();
  });

  it("serves the existing run and trace routes from memory", async () => {
    const store = new MemoryStore();
    const app = buildApp({ logger: false, store });
    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      assert.equal(health.statusCode, 200);
      assert.equal(health.json().run_store, "memory");
      assert.equal(health.json().agent_store, "memory");

      const run = baselineRun();
      const trace = baselineTrace();
      await store.saveRun(run);
      await store.saveTrace(trace);

      const list = await app.inject({ method: "GET", url: "/runs" });
      assert.equal(list.statusCode, 200);
      assert.equal(list.json().runs.length, 1);
      assert.equal(list.json().runs[0].run_id, run.run_id);
      assert.equal(Object.hasOwn(list.json().runs[0], "created_at"), false);
      assert.equal(list.json().trace_links[0].first_trace_id, trace.trace_id);
      assert.equal(list.json().trace_links[0].traces[0].outcome.verifier.passed, true);
      assert.equal(list.json().counts.scope, "harness_session");
      assert.equal(list.json().counts.runs, 1);

      const one = await app.inject({ method: "GET", url: `/runs/${run.run_id}` });
      assert.equal(one.statusCode, 200);
      assert.deepEqual(one.json(), run);

      const traces = await app.inject({ method: "GET", url: "/traces" });
      assert.equal(traces.statusCode, 200);
      assert.equal(traces.json().traces[0].diagnosis, null);
      assert.equal(Object.hasOwn(traces.json().traces[0], "phase"), false);

      const storedTrace = await app.inject({ method: "GET", url: `/traces/${trace.trace_id}` });
      assert.equal(storedTrace.statusCode, 200);
      assert.deepEqual(storedTrace.json(), trace);

      const missingRun = await app.inject({ method: "GET", url: "/runs/missing-run" });
      assert.equal(missingRun.statusCode, 404);
      assert.deepEqual(missingRun.json(), { error: "not_found", message: "No run missing-run" });

      const missingTrace = await app.inject({ method: "GET", url: "/traces/missing-trace" });
      assert.equal(missingTrace.statusCode, 404);
      assert.deepEqual(missingTrace.json(), { error: "not_found", message: "No trace missing-trace" });
    } finally {
      await app.close();
      await store.close();
    }
  });
});
