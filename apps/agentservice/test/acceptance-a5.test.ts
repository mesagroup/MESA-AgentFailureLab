import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { Agent, Trace } from "@mesa/shared";
import { validateAgent } from "@mesa/shared/validate";
import { MemoryStore } from "../../backend/src/persistence/memory.js";
import { startOfflineShop } from "../scripts/demo-shop-offline.js";

/**
 * Targeted #101 matrix cases that existing #99/#100 tests do not exercise over
 * the offline HTTP stack. Happy-path, empty/ineffective proposal, missing
 * controls, live-unconfigured, and regression formula coverage stay in
 * demo-shop.test.ts, canonical-scenario.test.ts, fix-verification.test.ts,
 * diagnosis.test.ts, world-gate.test.ts, and runs-postgres.test.ts.
 */
function agent(): Agent {
  const parsed = validateAgent(JSON.parse(readFileSync(new URL("../scenarios/shop-readback-v1/agent.json", import.meta.url), "utf8")));
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.value;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const injection = JSON.parse(readFileSync(new URL("../scenarios/shop-readback-v1/scenario.json", import.meta.url), "utf8")).injection_plan;

describe("A5 acceptance matrix gaps (offline HTTP)", { concurrency: false }, () => {
  it("returns world_busy for a second simultaneous start and does not reset the first run", { timeout: 20_000 }, async () => {
    const hold = deferred();
    const ready = deferred();
    let setups = 0;
    const lab = await startOfflineShop(agent(), undefined, {
      afterWorldSetup: async () => {
        setups += 1;
        if (setups !== 1) return;
        ready.resolve();
        await hold.promise;
      },
    });
    try {
      const first = fetch(`${lab.backendUrl}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent_id: lab.agent.agent_id, phase: "baseline", task_ids: ["read-product"], driver: "http" }),
      });
      await ready.promise;
      const second = await fetch(`${lab.backendUrl}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent_id: lab.agent.agent_id, phase: "baseline", task_ids: ["add-mugs"], driver: "http" }),
      });
      assert.equal(second.status, 409);
      assert.deepEqual(await second.json(), {
        error: "world_busy",
        message: "The mock world is busy with another run on this process. Retry after that run finishes. This is not a verifier failure.",
      });
      const health = await (await fetch(`${lab.backendUrl}/health`)).json() as { run_store: string };
      assert.equal(health.run_store, "memory");
      hold.resolve();
      const done = await first;
      assert.equal(done.status, 200);
      const body = await done.json() as { results: Array<{ run: { status: string }; trace: { task_id: string; diagnosis: null } }> };
      assert.equal(body.results[0].run.status, "passed");
      assert.equal(body.results[0].trace.task_id, "read-product");
      assert.equal(body.results[0].trace.diagnosis, null);
      assert.equal((await lab.store.listRuns()).length, 1);
    } finally {
      hold.resolve();
      await lab.close();
    }
  });

  it("retries diagnose on the same trace_id from cache and leaves the original document otherwise intact", { timeout: 20_000 }, async () => {
    let modelCalls = 0;
    const lab = await startOfflineShop(agent(), {
      complete: async request => {
        modelCalls += 1;
        const view = JSON.parse(request.user) as { steps: Trace["steps"]; fault?: unknown; outcome?: unknown };
        assert.equal(view.fault, undefined);
        assert.equal(view.outcome, undefined);
        const step = [...view.steps].reverse().find(item => item.type === "message" && item.role === "assistant");
        assert.ok(step);
        return {
          content: JSON.stringify({
            category: "Verification",
            cause: "Offline fixture for diagnose retry.",
            step_id: step.step_id,
            confidence: 0.8,
            evidence: [`${step.step_id} claims completion`],
            proposed_fixes: ["pre_response_check"],
          }),
          usage: null,
        };
      },
    });
    try {
      const injected = await fetch(`${lab.backendUrl}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent_id: lab.agent.agent_id, phase: "injected", task_ids: ["read-product"], driver: "http", injection,
        }),
      });
      assert.equal(injected.status, 200);
      const result = await injected.json() as { results: Array<{ run: { run_id: string }; trace: Trace }> };
      const original = result.results[0].trace;
      assert.equal(original.diagnosis, null);
      const path = `${lab.backendUrl}/traces/${original.trace_id}/diagnose`;
      const first = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(first.status, 200);
      assert.equal(first.headers.get("x-diagnosis-cached"), "false");
      const diagnosed = await first.json() as Trace;
      assert.ok(diagnosed.diagnosis);
      assert.equal(diagnosed.outcome.verifier.passed, original.outcome.verifier.passed);
      assert.deepEqual(diagnosed.fault, original.fault);
      const second = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(second.status, 200);
      assert.equal(second.headers.get("x-diagnosis-cached"), "true");
      assert.equal(second.headers.get("x-diagnosis-duration-ms"), null);
      assert.deepEqual(await second.json(), diagnosed);
      assert.equal(modelCalls, 1);
      assert.deepEqual(await lab.store.getTrace(original.trace_id), diagnosed);
      assert.equal((await lab.store.getRun(result.results[0].run.run_id))?.run_id, result.results[0].run.run_id);
    } finally { await lab.close(); }
  });

  it("documents in-memory restart as loss: a new MemoryStore does not see the previous process rows", async () => {
    const lab = await startOfflineShop(agent());
    try {
      const response = await fetch(`${lab.backendUrl}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent_id: lab.agent.agent_id, phase: "baseline", task_ids: ["read-product"], driver: "http" }),
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { results: Array<{ run: { run_id: string }; trace: { trace_id: string; diagnosis: unknown } }> };
      const runId = body.results[0].run.run_id;
      const traceId = body.results[0].trace.trace_id;
      assert.ok(await lab.store.getRun(runId));
      assert.ok(await lab.store.getTrace(traceId));
      assert.equal(body.results[0].trace.diagnosis, null);
      const restarted = new MemoryStore();
      assert.equal(await restarted.getRun(runId), undefined);
      assert.equal(await restarted.getTrace(traceId), undefined);
      assert.equal((await restarted.listRuns()).length, 0);
    } finally { await lab.close(); }
  });

  it("does not re-run Postgres restart here; CI has no TEST_DATABASE_URL", {
    skip: "Postgres restart coverage is apps/backend/test/runs-postgres.test.ts (second pool still reads Run/Trace/Diagnosis). CI leaves TEST_DATABASE_URL unset; this collaudo does not open a database.",
  }, () => undefined);
});
