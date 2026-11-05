import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Diagnosis, Trace } from "@mesa/shared";
import { validateTrace } from "@mesa/shared/validate";
import { buildApp } from "../src/app.js";
import { MemoryStore } from "../src/persistence/memory.js";
import { DuplicateTraceError } from "../src/persistence/store.js";
import { TRACE_IMPORT_BODY_LIMIT } from "../src/traces/import.js";

const examples = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/shared/examples");

function readExample(name: string): unknown {
  return JSON.parse(readFileSync(join(examples, name), "utf8")) as unknown;
}

function productionT1(): Trace {
  const result = validateTrace(readExample("production/t1-search-product.json"));
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.value;
}

function productionDiagnosis(trace: Trace): Diagnosis {
  const step = trace.steps.find((entry) => entry.type === "tool_call") ?? trace.steps[0];
  assert.ok(step);
  return {
    category: "Verification",
    cause: "Stub diagnosis for an imported production trace.",
    step_id: step.step_id,
    confidence: 0.7,
    evidence: [`Culprit ${step.step_id} on an imported production document.`],
    proposed_fixes: ["pre_response_check"],
  };
}

describe("POST /traces production import", () => {
  it("inserts a production fixture, stamps source, lists it, and diagnoses via the stub path", async () => {
    const store = new MemoryStore();
    const fixture = productionT1();
    let posted: unknown;
    const app = buildApp({
      logger: false,
      store,
      diagnosis: {
        baseUrl: "http://agentservice.test",
        fetchImpl: async (_url, init) => {
          posted = JSON.parse(init?.body as string);
          const envelope = posted as Trace | { trace: Trace };
          const body = "trace" in envelope ? envelope.trace : envelope;
          return Response.json({ ...body, diagnosis: productionDiagnosis(body) });
        },
      },
    });
    try {
      const withClientSource = { ...fixture, source: "harness" as const };
      const created = await app.inject({ method: "POST", url: "/traces", payload: withClientSource });
      assert.equal(created.statusCode, 201, created.body);
      const saved = created.json() as Trace;
      assert.equal(validateTrace(saved).ok, true);
      assert.equal(saved.source, "production");
      assert.equal(saved.trace_id, fixture.trace_id);
      assert.equal(saved.fault.injected, false);
      assert.deepEqual(saved.fault.labels, []);
      assert.equal(saved.diagnosis, null);

      const one = await app.inject({ method: "GET", url: `/traces/${fixture.trace_id}` });
      assert.equal(one.statusCode, 200);
      assert.deepEqual(one.json(), saved);

      const listed = await app.inject({ method: "GET", url: "/traces?source=production" });
      assert.equal(listed.statusCode, 200);
      assert.equal(listed.json().traces.length, 1);
      assert.equal(listed.json().traces[0].trace_id, fixture.trace_id);

      const diagnosed = await app.inject({ method: "POST", url: `/traces/${fixture.trace_id}/diagnose` });
      assert.equal(diagnosed.statusCode, 200, diagnosed.body);
      assert.equal(diagnosed.json().source, "production");
      assert.deepEqual(diagnosed.json().diagnosis, productionDiagnosis(fixture));
      const envelope = posted as Trace | { trace: Trace };
      assert.deepEqual("trace" in envelope ? envelope.trace : envelope, saved);
      assert.deepEqual((await store.getTrace(fixture.trace_id))?.diagnosis, productionDiagnosis(fixture));
    } finally {
      await app.close();
      await store.close();
    }
  });

  it("returns 409 without overwriting when the trace id already exists", async () => {
    const store = new MemoryStore();
    const fixture = productionT1();
    await store.saveTrace({ ...fixture, source: "demo_seed" });
    const app = buildApp({ logger: false, store });
    try {
      const again = await app.inject({
        method: "POST",
        url: "/traces",
        payload: { ...fixture, task_id: "T9" },
      });
      assert.equal(again.statusCode, 409);
      assert.deepEqual(again.json(), {
        error: "conflict",
        message: `Trace ${fixture.trace_id} already exists.`,
      });
      assert.equal((await store.getTrace(fixture.trace_id))?.source, "demo_seed");
      assert.equal((await store.getTrace(fixture.trace_id))?.task_id, fixture.task_id);
    } finally {
      await app.close();
      await store.close();
    }
  });

  it("rejects injector fault.* with 400 fault_forbidden", async () => {
    const injected = validateTrace(readExample("injected-failed-trace.json"));
    assert.equal(injected.ok, true);
    if (!injected.ok) return;
    const app = buildApp({ logger: false, store: new MemoryStore() });
    try {
      const result = await app.inject({ method: "POST", url: "/traces", payload: injected.value });
      assert.equal(result.statusCode, 400);
      assert.equal(result.json().error, "fault_forbidden");
      assert.match(result.json().message, /fault\.\*/);
      const listed = await app.inject({ method: "GET", url: `/traces/${injected.value.trace_id}` });
      assert.equal(listed.statusCode, 404);
    } finally {
      await app.close();
    }
  });

  it("rejects a schema-invalid body with 400 invalid_trace", async () => {
    const app = buildApp({ logger: false, store: new MemoryStore() });
    try {
      const result = await app.inject({
        method: "POST",
        url: "/traces",
        payload: { trace_id: "not-a-trace" },
      });
      assert.equal(result.statusCode, 400);
      assert.equal(result.json().error, "invalid_trace");
      assert.ok(Array.isArray(result.json().errors));
      const malformed = await app.inject({
        method: "POST",
        url: "/traces",
        headers: { "content-type": "application/json" },
        payload: "{bad json",
      });
      assert.equal(malformed.statusCode, 400);
      assert.equal(malformed.json().error, "invalid_request");
    } finally {
      await app.close();
    }
  });

  it("rejects a body larger than the documented limit with 413", async () => {
    const app = buildApp({ logger: false, store: new MemoryStore() });
    try {
      const result = await app.inject({
        method: "POST",
        url: "/traces",
        headers: { "content-type": "application/json" },
        payload: `{${"x".repeat(TRACE_IMPORT_BODY_LIMIT)}}`,
      });
      assert.equal(result.statusCode, 413);
      assert.equal(result.json().error, "payload_too_large");
    } finally {
      await app.close();
    }
  });

  it("insertTrace refuses a second copy in memory", async () => {
    const store = new MemoryStore();
    const fixture = productionT1();
    const first = await store.insertTrace({ ...fixture, source: "production" });
    assert.equal(first.source, "production");
    await assert.rejects(store.insertTrace({ ...fixture, source: "harness" }), (error: unknown) => {
      assert.ok(error instanceof DuplicateTraceError);
      assert.equal(error.traceId, fixture.trace_id);
      return true;
    });
    assert.equal((await store.getTrace(fixture.trace_id))?.source, "production");
    await store.close();
  });
});
