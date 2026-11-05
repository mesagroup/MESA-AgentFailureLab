import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateRun, validateTrace } from "@mesa/shared/validate";
import { LIBRARY_AGENT_ID, MemoryAgentStore, REFERENCE_AGENT_ID, seedFixtures } from "../src/agents/store.js";
import { buildApp } from "../src/app.js";
import {
  DEMO_SEED_PAIRS,
  DEMO_SEED_RUN_IDS,
  DEMO_SEED_TRACE_IDS,
  seedDemoRunsAndTraces,
} from "../src/persistence/demo-seed.js";
import { MemoryStore } from "../src/persistence/memory.js";
import { resetKeepingSeed } from "../src/persistence/transfer.js";
import type { Run, Trace } from "@mesa/shared";

describe("demo seed runs and traces", () => {
  it("is exactly two agents and at least three validated traces per domain", () => {
    const agents = seedFixtures({});
    assert.deepEqual(
      agents.map((agent) => agent.agent_id),
      [REFERENCE_AGENT_ID, LIBRARY_AGENT_ID],
    );
    assert.equal(agents.length, 2);
    assert.equal(DEMO_SEED_PAIRS.length, 6);
    const shop = DEMO_SEED_PAIRS.filter((pair) => pair.trace.agent_id === REFERENCE_AGENT_ID);
    const library = DEMO_SEED_PAIRS.filter((pair) => pair.trace.agent_id === LIBRARY_AGENT_ID);
    assert.equal(shop.length, 3);
    assert.equal(library.length, 3);
    for (const pair of DEMO_SEED_PAIRS) {
      assert.equal(validateTrace(pair.trace).ok, true, pair.trace.trace_id);
      assert.equal(validateRun(pair.run).ok, true, pair.run.run_id);
      assert.equal(pair.run.agent_id, pair.trace.agent_id);
      assert.equal(pair.run.run_id, pair.trace.run_id);
      assert.deepEqual(pair.run.trace_ids, [pair.trace.trace_id]);
      assert.equal(pair.run.phase, "baseline");
      assert.equal(pair.run.injection_plan, null);
      assert.deepEqual(pair.run.fix_kinds, []);
      assert.equal(pair.trace.diagnosis, null);
      assert.equal(pair.trace.fault.injected, false);
      assert.deepEqual(pair.trace.fault.labels, []);
      assert.equal(pair.trace.outcome.success, pair.trace.outcome.verifier.passed);
      assert.ok(pair.trace.task_id);
      assert.ok(pair.trace.started_at <= pair.trace.ended_at);
    }
    assert.equal(agents[0]?.otel?.schema_id, "mesa.otel.shop.a");
    assert.equal(agents[0]?.otel?.prod.auth.type, "none");
    assert.equal(agents[0]?.otel_mock?.schema_id, "mesa.otel.shop.a");
    assert.equal(agents[1]?.otel?.schema_id, "mesa.otel.library.b");
    assert.equal(agents[1]?.otel?.test.auth.type, "none");
    assert.equal(agents[1]?.otel_mock?.schema_id, "mesa.otel.library.b");
    assert.deepEqual(
      shop.map((pair) => pair.trace.task_id),
      ["T1", "T3", "T2"],
    );
    assert.deepEqual(
      library.map((pair) => pair.trace.task_id),
      ["renew-loan", "return-loan", "place-hold"],
    );
    for (const pair of library) {
      const blob = JSON.stringify(pair.trace.steps);
      assert.equal(blob.includes("add_to_cart"), false);
      assert.equal(blob.includes("checkout"), false);
    }
  });

  it("inserts on a clean store, is idempotent, and does not touch other rows", async () => {
    const store = new MemoryStore();
    const first = await seedDemoRunsAndTraces(store);
    assert.equal(Object.values(first.traces).every((result) => result === "inserted"), true);
    assert.equal(Object.values(first.runs).every((result) => result === "inserted"), true);
    assert.deepEqual(
      (await store.listTraces()).map((trace) => trace.trace_id),
      [...DEMO_SEED_TRACE_IDS],
    );
    assert.deepEqual(
      (await store.listRuns()).map((run) => run.run_id),
      [...DEMO_SEED_RUN_IDS],
    );

    const edited = await store.getTrace(DEMO_SEED_TRACE_IDS[0]!);
    assert.ok(edited);
    edited.outcome.agent_claimed_success = false;
    await store.saveTrace(edited);

    const extraRun: Run = {
      ...(await store.getRun(DEMO_SEED_RUN_IDS[0]!))!,
      run_id: "user-run-keep",
      trace_ids: ["user-trace-keep"],
    };
    const extraTrace: Trace = {
      ...(await store.getTrace(DEMO_SEED_TRACE_IDS[0]!))!,
      trace_id: "user-trace-keep",
      run_id: "user-run-keep",
    };
    await store.saveRun(extraRun);
    await store.saveTrace(extraTrace);

    const second = await seedDemoRunsAndTraces(store);
    assert.equal(Object.values(second.traces).every((result) => result === "kept"), true);
    assert.equal(Object.values(second.runs).every((result) => result === "kept"), true);
    assert.equal((await store.getTrace(DEMO_SEED_TRACE_IDS[0]!))?.outcome.agent_claimed_success, false);
    assert.equal(await store.getRun("user-run-keep") !== undefined, true);
    assert.equal(await store.getTrace("user-trace-keep") !== undefined, true);
    assert.equal((await store.listTraces()).length, DEMO_SEED_TRACE_IDS.length + 1);
    assert.equal((await store.listRuns()).length, DEMO_SEED_RUN_IDS.length + 1);
    await store.close();
  });

  it("returns the demo traces from GET /traces after a clean seed", async () => {
    const store = new MemoryStore();
    await seedDemoRunsAndTraces(store);
    const app = buildApp({ logger: false, store });
    try {
      const agents = await app.inject({ method: "GET", url: "/agents" });
      assert.equal(agents.statusCode, 200);
      const listed = agents.json().agents as Array<{ agent_id: string }>;
      assert.deepEqual(
        listed.map((agent) => agent.agent_id),
        [REFERENCE_AGENT_ID, LIBRARY_AGENT_ID],
      );
      assert.equal(listed.length, 2);

      const tracesRes = await app.inject({ method: "GET", url: "/traces" });
      assert.equal(tracesRes.statusCode, 200);
      const traces = tracesRes.json().traces as Trace[];
      assert.equal(traces.length, DEMO_SEED_TRACE_IDS.length);
      assert.deepEqual(
        traces.map((trace) => trace.trace_id),
        [...DEMO_SEED_TRACE_IDS],
      );
      assert.equal(traces.filter((trace) => trace.agent_id === REFERENCE_AGENT_ID).length, 3);
      assert.equal(traces.filter((trace) => trace.agent_id === LIBRARY_AGENT_ID).length, 3);

      for (const pair of DEMO_SEED_PAIRS) {
        const storedTrace = await app.inject({ method: "GET", url: `/traces/${pair.trace.trace_id}` });
        assert.equal(storedTrace.statusCode, 200);
        assert.equal(storedTrace.json().run_id, pair.run.run_id);
        const storedRun = await app.inject({ method: "GET", url: `/runs/${pair.run.run_id}` });
        assert.equal(storedRun.statusCode, 200);
        assert.deepEqual(storedRun.json().trace_ids, [pair.trace.trace_id]);
      }
    } finally {
      await app.close();
      await store.close();
    }
  });

  it("reinserts demo traces after reset and still lists only the two demo agents", async () => {
    const agents = new MemoryAgentStore();
    const runs = new MemoryStore();
    await seedDemoRunsAndTraces(runs);
    const seed = await agents.get(REFERENCE_AGENT_ID);
    assert.ok(seed);
    await agents.upsertImported({
      ...seed,
      agent_id: "third-agent-should-go",
      name: "Third",
    });
    const counts = await resetKeepingSeed(agents, runs);
    assert.equal(counts.agents_deleted, 1);
    assert.equal(Object.values(counts.demo.traces).every((result) => result === "inserted"), true);
    assert.deepEqual(
      (await agents.list()).map((agent) => agent.agent_id),
      [REFERENCE_AGENT_ID, LIBRARY_AGENT_ID],
    );
    assert.equal((await agents.list()).length, 2);
    assert.deepEqual(
      (await runs.listTraces()).map((trace) => trace.trace_id),
      [...DEMO_SEED_TRACE_IDS],
    );
    await agents.close();
    await runs.close();
  });
});
