import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { TASK_EVALSET_VERSION, type Trace } from "@mesa/shared";
import type { FastifyInstance } from "fastify";
import { MemoryAgentStore } from "../src/agents/store.js";
import { buildApp } from "../src/app.js";
import { MemoryStore } from "../src/persistence/memory.js";
import { diagnosis, diagnosisRun, diagnosisTrace, deferred } from "./diagnosis-fixtures.js";

const path = `/traces/${diagnosisTrace().trace_id}/diagnose`;

async function seeded(store = new MemoryStore()) {
  await store.saveRun(diagnosisRun());
  await store.saveTrace(diagnosisTrace());
  return store;
}

function response(trace = diagnosisTrace()) {
  return Response.json({ ...trace, diagnosis: diagnosis() });
}

describe("stored trace diagnosis", () => {
  it("posts the authoritative trace to the server-configured URL and returns it from GET", async () => {
    const store = await seeded();
    let calls = 0;
    const app = buildApp({ logger: false, store, diagnosis: {
      baseUrl: "http://agentservice.test/prefix/",
      fetchImpl: async (url, init) => {
        calls++;
        assert.equal(url, "http://agentservice.test/prefix/diagnose");
        assert.equal(init?.method, "POST");
        assert.deepEqual(JSON.parse(init?.body as string), diagnosisTrace());
        return response();
      },
    } });
    try {
      const result = await app.inject({ method: "POST", url: path });
      assert.equal(result.statusCode, 200);
      assert.equal(result.headers["x-diagnosis-cached"], "false");
      assert.ok(Number(result.headers["x-diagnosis-duration-ms"]) >= 0);
      const expected = { ...diagnosisTrace(), diagnosis: diagnosis() };
      assert.deepEqual(result.json(), expected);
      assert.deepEqual((await app.inject({ method: "GET", url: path.replace(/\/diagnose$/, "") })).json(), expected);
      assert.deepEqual(await store.getRun(diagnosisRun().run_id), diagnosisRun());
      const cached = await app.inject({ method: "POST", url: path, payload: {} });
      assert.equal(cached.statusCode, 200);
      assert.equal(cached.headers["x-diagnosis-cached"], "true");
      assert.equal(cached.headers["x-diagnosis-duration-ms"], undefined);
      assert.equal(calls, 1);
    } finally { await app.close(); }
  });

  it("serves an existing diagnosis even with upstream disabled", async () => {
    const store = await seeded();
    await store.saveDiagnosis(diagnosisTrace(), diagnosis());
    const app = buildApp({ logger: false, store, diagnosis: { baseUrl: null } });
    try {
      const result = await app.inject({ method: "POST", url: path });
      assert.equal(result.statusCode, 200);
      assert.deepEqual(result.json().diagnosis, diagnosis());
    } finally { await app.close(); }
  });

  it("rejects caller documents, URLs and force/re-diagnose flags", async () => {
    const store = await seeded();
    let calls = 0;
    const app = buildApp({ logger: false, store, diagnosis: { baseUrl: "http://agentservice.test", fetchImpl: async () => { calls++; return response(); } } });
    try {
      for (const payload of [diagnosisTrace(), { diagnosis: diagnosis() }, { url: "http://other" }, { force: true }, [], null]) {
        const result = await app.inject({ method: "POST", url: path, headers: { "content-type": "application/json" }, payload: JSON.stringify(payload) });
        assert.equal(result.statusCode, 400);
      }
      assert.equal(calls, 0);
      const malformed = await app.inject({ method: "POST", url: path, headers: { "content-type": "application/json" }, payload: "{bad json" });
      assert.equal(malformed.statusCode, 400);
      assert.deepEqual(malformed.json(), { error: "invalid_request" });
      assert.deepEqual(await store.getTrace(diagnosisTrace().trace_id), diagnosisTrace());
    } finally { await app.close(); }
  });

  for (const failure of [
    { name: "missing trace", url: "/traces/missing/diagnose", baseUrl: null, status: 404, code: "not_found" },
    { name: "unconfigured upstream", baseUrl: null, status: 503, code: "diagnosis_not_configured" },
    { name: "Grok unavailable", status: 503, code: "diagnosis_unavailable", fetchImpl: async () => new Response("secret upstream body", { status: 503 }) },
    { name: "upstream HTTP failure", status: 502, code: "diagnosis_upstream_error", fetchImpl: async () => new Response("secret upstream body", { status: 500 }) },
    { name: "transport failure", status: 502, code: "diagnosis_upstream_error", fetchImpl: async () => { throw new Error("sensitive transport URL"); } },
    { name: "malformed JSON", status: 502, code: "diagnosis_upstream_error", fetchImpl: async () => new Response("not JSON") },
    { name: "invalid Diagnosis", status: 502, code: "invalid_diagnosis_response", fetchImpl: async () => Response.json({ ...diagnosisTrace(), diagnosis: { ...diagnosis(), proposed_fixes: ["invented_fix"] } }) },
    { name: "missing Diagnosis", status: 502, code: "invalid_diagnosis_response", fetchImpl: async () => Response.json(diagnosisTrace()) },
    { name: "nonexistent culprit step", status: 502, code: "invalid_diagnosis_response", fetchImpl: async () => Response.json({ ...diagnosisTrace(), diagnosis: { ...diagnosis(), step_id: "step-missing" } }) },
  ]) {
    it(`preserves the original on ${failure.name}`, async () => {
      const store = await seeded();
      const app = buildApp({ logger: false, store, diagnosis: { baseUrl: failure.baseUrl === null ? null : "http://agentservice.test", fetchImpl: failure.fetchImpl } });
      try {
        const result = await app.inject({ method: "POST", url: failure.url ?? path });
        assert.equal(result.statusCode, failure.status);
        assert.equal(result.json().error, failure.code);
        assert.deepEqual(await store.getTrace(diagnosisTrace().trace_id), diagnosisTrace());
        assert.deepEqual(await store.getRun(diagnosisRun().run_id), diagnosisRun());
        assert.doesNotMatch(result.body, /secret|sensitive/);
      } finally { await app.close(); }
    });
  }

  it("times out and releases the per-trace gate", async () => {
    const store = await seeded();
    let calls = 0;
    const app = buildApp({ logger: false, store, diagnosis: { baseUrl: "http://agentservice.test", timeoutMs: 20,
      fetchImpl: async (_url, init) => {
        if (++calls > 1) return response();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    } });
    try {
      // The listening socket keeps the event loop alive while AbortSignal's
      // unref'ed timeout fires against the deliberately pending fake request.
      await app.listen({ host: "127.0.0.1", port: 0 });
      const result = await app.inject({ method: "POST", url: path });
      assert.equal(result.statusCode, 504);
      assert.equal(result.json().error, "diagnosis_timeout");
      assert.deepEqual(await store.getTrace(diagnosisTrace().trace_id), diagnosisTrace());
      assert.equal((await app.inject({ method: "POST", url: path })).statusCode, 200);
    } finally { await app.close(); }
  });

  it("applies the deadline while reading a stalled upstream response body", async () => {
    const server = createServer((_request, reply) => {
      reply.writeHead(200, { "content-type": "application/json" });
      reply.write('{"trace_id":'); // Headers arrived, but the body never finishes.
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const store = await seeded();
    const app = buildApp({ logger: false, store, diagnosis: { baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 100 } });
    try {
      const result = await app.inject({ method: "POST", url: path });
      assert.equal(result.statusCode, 504);
      assert.equal(result.json().error, "diagnosis_timeout");
      assert.deepEqual(await store.getTrace(diagnosisTrace().trace_id), diagnosisTrace());
    } finally {
      await app.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  const mutations: Array<[string, (trace: Trace) => void]> = [
    ["outcome", trace => { trace.outcome.agent_claimed_success = false; }],
    ["fault", trace => { trace.fault.labels[0].code = "different-code"; }],
    ["steps", trace => { trace.steps[0].content = "rewritten"; }],
    ["identity", trace => { trace.agent_id = "another-agent"; }],
    ["totals", trace => { trace.totals.cost_usd = 100; }],
    ["times", trace => { trace.ended_at = "2026-11-05T00:00:00.000Z"; }],
  ];
  for (const [name, mutate] of mutations) {
    it(`rejects upstream changes to ${name}`, async () => {
      const store = await seeded();
      const tampered = diagnosisTrace();
      mutate(tampered);
      const app = buildApp({ logger: false, store, diagnosis: { baseUrl: "http://agentservice.test", fetchImpl: async () => response(tampered) } });
      try {
        const result = await app.inject({ method: "POST", url: path });
        assert.equal(result.statusCode, 502);
        assert.deepEqual(await store.getTrace(diagnosisTrace().trace_id), diagnosisTrace());
      } finally { await app.close(); }
    });
  }

  it("rejects simultaneous diagnoses without blocking reads or diagnosing another trace", async () => {
    const store = await seeded();
    const other = { ...diagnosisTrace(), trace_id: "trace-other" };
    await store.saveTrace(other);
    const entered = deferred(), release = deferred();
    let calls = 0;
    const app = buildApp({ logger: false, store, diagnosis: { baseUrl: "http://agentservice.test", fetchImpl: async (_url, init) => {
      const trace = JSON.parse(init?.body as string) as Trace;
      calls++;
      if (trace.trace_id !== other.trace_id) { entered.resolve(); await release.promise; }
      return response(trace);
    } } });
    try {
      const first = app.inject({ method: "POST", url: path }).then(result => result);
      await entered.promise;
      assert.equal((await app.inject({ method: "POST", url: path })).statusCode, 409);
      assert.equal((await app.inject({ method: "GET", url: "/traces" })).statusCode, 200);
      assert.equal((await app.inject({ method: "POST", url: `/traces/${other.trace_id}/diagnose` })).statusCode, 200);
      release.resolve();
      assert.equal((await first).statusCode, 200);
      assert.equal(calls, 2);
    } finally { release.resolve(); await app.close(); }
  });

  it("rejects stale diagnosis when a trace changes or is deleted during the upstream call", async () => {
    for (const deleted of [false, true]) {
      const store = await seeded();
      const changed = { ...diagnosisTrace(), diagnosis: { ...diagnosis(), cause: "Another writer's diagnosis" } };
      const app = buildApp({ logger: false, store, diagnosis: { baseUrl: "http://agentservice.test", fetchImpl: async () => {
        if (deleted) await store.deleteAllRunsAndTraces();
        else await store.saveTrace(changed);
        return response();
      } } });
      try {
        const result = await app.inject({ method: "POST", url: path });
        assert.equal(result.statusCode, 409);
        assert.equal(result.json().error, "trace_changed");
        assert.deepEqual(await store.getTrace(diagnosisTrace().trace_id), deleted ? undefined : changed);
      } finally { await app.close(); }
    }
  });

  it("preserves the trace on save failure and permits a subsequent retry", async () => {
    const store = await seeded();
    const save = store.saveDiagnosis.bind(store);
    store.saveDiagnosis = async () => { throw new Error("secret database URL"); };
    const app = buildApp({ logger: false, store, diagnosis: { baseUrl: "http://agentservice.test", fetchImpl: async () => response() } });
    try {
      const result = await app.inject({ method: "POST", url: path });
      assert.equal(result.statusCode, 500);
      assert.deepEqual(result.json(), { error: "diagnosis_store_error" });
      assert.deepEqual(await store.getTrace(diagnosisTrace().trace_id), diagnosisTrace());
      store.saveDiagnosis = save;
      assert.equal((await app.inject({ method: "POST", url: path })).statusCode, 200);
    } finally { await app.close(); }
  });

  it("accepts semantic object-key reordering and returns a detached stored document", async () => {
    const store = await seeded();
    const trace = diagnosisTrace();
    const reordered = Object.fromEntries(Object.entries(trace).reverse());
    const app = buildApp({ logger: false, store, diagnosis: { baseUrl: "http://agentservice.test", fetchImpl: async () => Response.json({ ...reordered, diagnosis: diagnosis() }) } });
    try {
      assert.equal((await app.inject({ method: "POST", url: path })).statusCode, 200);
      const read = await store.getTrace(trace.trace_id);
      assert.ok(read?.diagnosis);
      read.diagnosis.cause = "mutated by caller";
      assert.deepEqual((await store.getTrace(trace.trace_id))?.diagnosis, diagnosis());
    } finally { await app.close(); }
  });

  it("connects to the real agentservice over loopback with an explicitly offline model", async () => {
    const module = await import(new URL("../../agentservice/src/app.ts", import.meta.url).href) as {
      buildApp: (options: { logger: boolean; config: { apiKey: null; baseUrl: string; modelName: string; timeoutMs: number }; model: { complete: (input: { system: string; user: string }) => Promise<{ content: string; usage: null }> } }) => FastifyInstance;
    };
    let modelCalls = 0;
    const service = module.buildApp({ logger: false,
      config: { apiKey: null, baseUrl: "http://unused.invalid", modelName: "offline-test", timeoutMs: 1000 },
      model: { complete: async input => {
        modelCalls++;
        const view = JSON.parse(input.user);
        assert.equal(view.fault, undefined);
        assert.equal(view.outcome, undefined);
        assert.equal(Object.hasOwn(view, "task_evalset"), false);
        assert.equal(input.system.includes("task_evalset is user-written guidance"), false);
        assert.doesNotMatch(input.user, /jury-nota-malevola-cancel|unauthorized_cancel_via_juror_note/);
        return { content: JSON.stringify(diagnosis()), usage: null };
      } },
    });
    const baseUrl = await service.listen({ host: "127.0.0.1", port: 0 });
    const store = await seeded();
    const app = buildApp({ logger: false, store, diagnosis: { baseUrl } });
    try {
      const result = await app.inject({ method: "POST", url: path });
      assert.equal(result.statusCode, 200);
      assert.equal(result.json().diagnosis.category, "Security");
      assert.deepEqual(result.json(), await store.getTrace(diagnosisTrace().trace_id));
      assert.deepEqual(result.json().outcome, diagnosisTrace().outcome);
      assert.equal(modelCalls, 1);
    } finally { await app.close(); await service.close(); }
  });

  it("sends the task evalset for agent_id and task_id and keeps the verifier", async () => {
    const store = await seeded();
    const trace = diagnosisTrace();
    trace.task_id = "T1";
    await store.saveTrace(trace);
    const agents = new MemoryAgentStore();
    const evalset = (await agents.get("reference-shop"))?.tasks.find((task) => task.task_id === "T1")?.evalset;
    assert.ok(evalset);
    assert.equal(evalset.cases[0]?.case_id, "claim-after-catalog");
    let body: unknown;
    const app = buildApp({ logger: false, store, agents, diagnosis: {
      baseUrl: "http://agentservice.test",
      fetchImpl: async (_url, init) => {
        body = JSON.parse(init?.body as string);
        return Response.json({ ...trace, diagnosis: diagnosis() });
      },
    } });
    try {
      const result = await app.inject({ method: "POST", url: `/traces/${trace.trace_id}/diagnose` });
      assert.equal(result.statusCode, 200);
      assert.deepEqual(body, { trace, task_evalset: evalset });
      assert.deepEqual(result.json().outcome.verifier, trace.outcome.verifier);
      assert.deepEqual(result.json().fault, trace.fault);
      assert.deepEqual(result.json().diagnosis, diagnosis());
      assert.equal(Object.hasOwn(result.json(), "task_evalset"), false);
      assert.deepEqual(await store.getTrace(trace.trace_id), result.json());
    } finally { await app.close(); }
  });

  it("rejects an upstream verifier change when the evalset was sent", async () => {
    const store = await seeded();
    const trace = diagnosisTrace();
    trace.task_id = "T1";
    await store.saveTrace(trace);
    const agents = new MemoryAgentStore();
    const app = buildApp({ logger: false, store, agents, diagnosis: {
      baseUrl: "http://agentservice.test",
      fetchImpl: async () => {
        const tampered = structuredClone(trace);
        tampered.outcome.verifier.passed = !trace.outcome.verifier.passed;
        tampered.diagnosis = diagnosis();
        return Response.json(tampered);
      },
    } });
    try {
      const result = await app.inject({ method: "POST", url: `/traces/${trace.trace_id}/diagnose` });
      assert.equal(result.statusCode, 502);
      assert.equal(result.json().error, "invalid_diagnosis_response");
      const stored = await store.getTrace(trace.trace_id);
      assert.equal(stored?.diagnosis, null);
      assert.equal(stored?.outcome.verifier.passed, trace.outcome.verifier.passed);
      assert.deepEqual(stored?.outcome.verifier, trace.outcome.verifier);
    } finally { await app.close(); }
  });

  it("posts the trace alone when no task evalset resolves", async () => {
    for (const item of [
      { name: "T5 omits evalset", task_id: "T5", agent_id: "reference-shop" },
      { name: "unknown agent", task_id: "T1", agent_id: "missing-agent" },
      { name: "unknown task", task_id: "T9", agent_id: "reference-shop" },
    ]) {
      const store = await seeded();
      const trace = diagnosisTrace();
      trace.task_id = item.task_id;
      trace.agent_id = item.agent_id;
      await store.saveTrace(trace);
      let body: unknown;
      const app = buildApp({ logger: false, store, diagnosis: {
        baseUrl: "http://agentservice.test",
        fetchImpl: async (_url, init) => {
          body = JSON.parse(init?.body as string);
          return Response.json({ ...trace, diagnosis: diagnosis() });
        },
      } });
      try {
        const result = await app.inject({ method: "POST", url: `/traces/${trace.trace_id}/diagnose` });
        assert.equal(result.statusCode, 200, item.name);
        assert.deepEqual(body, trace, item.name);
        assert.deepEqual(result.json().outcome.verifier, trace.outcome.verifier, item.name);
        assert.equal(Object.hasOwn(result.json() as object, "task_evalset"), false, item.name);
      } finally { await app.close(); }
    }
  });

  it("sends a stored empty evalset and still writes diagnosis only", async () => {
    const store = await seeded();
    const agents = new MemoryAgentStore();
    const agent = await agents.get("reference-shop");
    assert.ok(agent);
    const next = structuredClone(agent);
    const task = next.tasks.find((item) => item.task_id === "T1");
    assert.ok(task);
    task.evalset = { version: TASK_EVALSET_VERSION, cases: [] };
    await agents.replace("reference-shop", next);
    const trace = diagnosisTrace();
    trace.task_id = "T1";
    await store.saveTrace(trace);
    let body: unknown;
    const app = buildApp({ logger: false, store, agents, diagnosis: {
      baseUrl: "http://agentservice.test",
      fetchImpl: async (_url, init) => {
        body = JSON.parse(init?.body as string);
        return Response.json({ ...trace, diagnosis: diagnosis() });
      },
    } });
    try {
      const result = await app.inject({ method: "POST", url: `/traces/${trace.trace_id}/diagnose` });
      assert.equal(result.statusCode, 200);
      assert.deepEqual(body, { trace, task_evalset: { version: TASK_EVALSET_VERSION, cases: [] } });
      assert.deepEqual(result.json().outcome.verifier, trace.outcome.verifier);
      assert.equal(Object.hasOwn(result.json(), "evalset"), false);
    } finally { await app.close(); }
  });

  it("passes the resolved evalset through to the offline model without changing the verifier", async () => {
    const module = await import(new URL("../../agentservice/src/app.ts", import.meta.url).href) as {
      buildApp: (options: { logger: boolean; config: { apiKey: null; baseUrl: string; modelName: string; timeoutMs: number }; model: { complete: (input: { system: string; user: string }) => Promise<{ content: string; usage: null }> } }) => FastifyInstance;
    };
    const store = await seeded();
    const trace = diagnosisTrace();
    trace.task_id = "T1";
    await store.saveTrace(trace);
    const agents = new MemoryAgentStore();
    const evalset = (await agents.get("reference-shop"))?.tasks.find((task) => task.task_id === "T1")?.evalset;
    assert.ok(evalset);
    let modelCalls = 0;
    const service = module.buildApp({ logger: false,
      config: { apiKey: null, baseUrl: "http://unused.invalid", modelName: "offline-test", timeoutMs: 1000 },
      model: { complete: async input => {
        modelCalls++;
        const view = JSON.parse(input.user) as { task_evalset?: unknown; fault?: unknown; outcome?: unknown };
        assert.deepEqual(view.task_evalset, evalset);
        assert.equal(view.fault, undefined);
        assert.equal(view.outcome, undefined);
        assert.match(input.system, /task_evalset is user-written guidance/);
        assert.match(input.system, /Do not write outcome\.verifier, fault\.injected, fault\.labels, fault\.attacker/);
        assert.doesNotMatch(input.user, /jury-nota-malevola-cancel|unauthorized_cancel_via_juror_note/);
        return { content: JSON.stringify(diagnosis()), usage: null };
      } },
    });
    const baseUrl = await service.listen({ host: "127.0.0.1", port: 0 });
    const app = buildApp({ logger: false, store, agents, diagnosis: { baseUrl } });
    try {
      const result = await app.inject({ method: "POST", url: `/traces/${trace.trace_id}/diagnose` });
      assert.equal(result.statusCode, 200);
      assert.equal(result.json().diagnosis.category, "Security");
      assert.equal(result.json().diagnosis.step_id, "step-3");
      assert.ok(result.json().diagnosis.evidence.includes("step-3 reports permission_denied"));
      assert.deepEqual(result.json().outcome.verifier, trace.outcome.verifier);
      assert.deepEqual(result.json().fault, trace.fault);
      assert.equal(Object.hasOwn(result.json(), "task_evalset"), false);
      assert.equal(modelCalls, 1);
    } finally { await app.close(); await service.close(); }
  });

  it("rejects unsafe configuration without echoing secret values", () => {
    for (const baseUrl of ["bad-url", "file:///tmp/file", "http://user:secret@service", "http://service?token=secret"]) {
      assert.throws(() => buildApp({ logger: false, diagnosis: { baseUrl } }), error => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /secret/);
        return true;
      });
    }
    assert.throws(() => buildApp({ logger: false, diagnosis: { baseUrl: null, timeoutMs: 0 } }), /DIAGNOSIS_TIMEOUT_MS/);
  });
});
