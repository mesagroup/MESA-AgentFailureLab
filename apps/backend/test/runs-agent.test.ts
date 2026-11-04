import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Agent, Run, Trace } from "@mesa/shared";
import { validateRun, validateTrace } from "@mesa/shared/validate";
import { REFERENCE_AGENT_ID } from "../src/agents/store.js";
import { buildApp } from "../src/app.js";
import { loadReferenceAgent } from "../src/reference-agent.js";
import { startMockShop } from "./helpers.js";

function taskById(agent: Agent, taskId: string) {
  const task = agent.tasks.find((entry) => entry.task_id === taskId);
  if (!task) throw new Error(`fixture has no ${taskId}`);
  return task;
}

/** Registered agent whose task list is T2 then T1, with prompts the seed does not use. */
function subsetAgent(): Agent {
  const source = loadReferenceAgent();
  return {
    ...source,
    agent_id: "cart-only",
    name: "Cart only",
    description: "Registered agent whose task list is T2 then T1.",
    instance: { ...source.instance, kind: "external" },
    tasks: [
      { ...taskById(source, "T2"), prompt: "CUSTOM-T2 add two mugs." },
      { ...taskById(source, "T1"), prompt: "CUSTOM-T1 open the mug." },
    ],
  };
}

function userPrompt(trace: Trace): string | undefined {
  return trace.steps.find((step) => step.type === "message" && step.role === "user")?.content;
}

function assertContract(run: Run, trace: Trace, agentId: string): void {
  assert.equal(run.agent_id, agentId);
  assert.equal(trace.agent_id, agentId);
  assert.equal(trace.run_id, run.run_id);
  assert.equal(trace.task_id, run.task_id);
  assert.equal(trace.diagnosis, null);
  assert.equal(trace.outcome.success, trace.outcome.verifier.passed);
  assert.equal(Object.hasOwn(trace, "phase"), false);
  assert.equal(Object.hasOwn(trace, "injection_plan"), false);
  assert.equal(Object.hasOwn(trace, "fix_kinds"), false);
  const storedRun = validateRun(run);
  const storedTrace = validateTrace(trace);
  assert.equal(storedRun.ok, true, storedRun.ok ? "" : storedRun.errors.join("; "));
  assert.equal(storedTrace.ok, true, storedTrace.ok ? "" : storedTrace.errors.join("; "));
}

describe("POST /runs selects a registry agent", { concurrency: false }, () => {
  let baseUrl = "";
  let closeShop: () => Promise<void> = async () => {};

  before(async () => {
    const shop = await startMockShop();
    baseUrl = shop.baseUrl;
    closeShop = shop.close;
  });

  after(async () => {
    await closeShop();
  });

  it("runs that agent's tasks, in document order, and stores the chosen agent_id", async () => {
    const app = buildApp({ logger: false, mockBaseUrl: baseUrl });
    try {
      const created = await app.inject({
        method: "POST",
        url: "/agents",
        payload: subsetAgent(),
      });
      assert.equal(created.statusCode, 201);
      assert.equal(created.json().agent_id, "cart-only");

      const batch = await app.inject({
        method: "POST",
        url: "/runs",
        payload: { agent_id: "cart-only" },
      });
      assert.equal(batch.statusCode, 200);
      const results = batch.json().results as Array<{ run: Run; trace: Trace }>;
      assert.deepEqual(
        results.map((result) => result.run.task_id),
        ["T2", "T1"],
      );
      assert.equal(results[0]?.run.phase, "baseline");
      assert.equal(results[0]?.run.status, "passed");
      assert.equal(userPrompt(results[0]!.trace), "CUSTOM-T2 add two mugs.");
      assert.deepEqual(
        results[0]?.trace.outcome.verifier.checks.map((check) => check.name),
        ["cart_contains"],
      );
      assert.equal(results[0]?.trace.outcome.verifier.passed, true);
      assertContract(results[0]!.run, results[0]!.trace, "cart-only");

      assert.equal(results[1]?.run.status, "passed");
      assert.equal(userPrompt(results[1]!.trace), "CUSTOM-T1 open the mug.");
      assert.deepEqual(
        results[1]?.trace.outcome.verifier.checks.map((check) => check.name),
        ["catalog_read", "product_viewed"],
      );
      assertContract(results[1]!.run, results[1]!.trace, "cart-only");

      const stored = await app.inject({ method: "GET", url: `/runs/${results[0]!.run.run_id}` });
      assert.equal(stored.statusCode, 200);
      assert.equal(stored.json().agent_id, "cart-only");
      assert.equal(stored.json().task_id, "T2");

      const before = (await app.inject({ method: "GET", url: "/runs" })).json().runs.length as number;
      const foreignTask = await app.inject({
        method: "POST",
        url: "/runs",
        payload: { agent_id: "cart-only", phase: "baseline", task_ids: ["T3"] },
      });
      assert.equal(foreignTask.statusCode, 400);
      assert.equal(foreignTask.json().error, "invalid_request");
      assert.match(foreignTask.json().message, /Agent cart-only has no task T3/);
      const after = (await app.inject({ method: "GET", url: "/runs" })).json().runs.length as number;
      assert.equal(after, before);

      const seed = (await app.inject({ method: "GET", url: `/agents/${REFERENCE_AGENT_ID}` })).json() as Agent;
      const t1 = taskById(seed, "T1");
      const edited = await app.inject({
        method: "PUT",
        url: `/agents/${REFERENCE_AGENT_ID}`,
        payload: {
          ...seed,
          tasks: [{ ...t1, prompt: "EDITED-SEED-T1" }],
        },
      });
      assert.equal(edited.statusCode, 200);

      const seedRun = await app.inject({
        method: "POST",
        url: "/runs",
        payload: { agent_id: REFERENCE_AGENT_ID },
      });
      assert.equal(seedRun.statusCode, 200);
      const seedResults = seedRun.json().results as Array<{ run: Run; trace: Trace }>;
      assert.equal(seedResults.length, 1);
      assert.equal(seedResults[0]?.run.task_id, "T1");
      assert.equal(seedResults[0]?.run.status, "passed");
      assert.equal(userPrompt(seedResults[0]!.trace), "EDITED-SEED-T1");
      assertContract(seedResults[0]!.run, seedResults[0]!.trace, REFERENCE_AGENT_ID);
    } finally {
      await app.close();
    }
  });

  it("returns 400 when agent_id is missing and 404 when the agent is not registered", async () => {
    const app = buildApp({ logger: false, mockBaseUrl: baseUrl });
    try {
      const bare = await app.inject({ method: "POST", url: "/runs" });
      assert.equal(bare.statusCode, 400);
      assert.deepEqual(bare.json(), { error: "invalid_request", message: "Body must be a JSON object." });

      const cases: Array<{ payload: object; message: string }> = [
        { payload: [], message: "Body must be a JSON object." },
        { payload: {}, message: "agent_id is required and must be a non-empty string." },
        {
          payload: { phase: "baseline", task_ids: ["T1"] },
          message: "agent_id is required and must be a non-empty string.",
        },
        { payload: { agent_id: "" }, message: "agent_id is required and must be a non-empty string." },
        { payload: { agent_id: "   " }, message: "agent_id is required and must be a non-empty string." },
        { payload: { agent_id: 12 }, message: "agent_id is required and must be a non-empty string." },
      ];

      for (const entry of cases) {
        const rejected = await app.inject({
          method: "POST",
          url: "/runs",
          payload: entry.payload,
        });
        assert.equal(rejected.statusCode, 400);
        assert.deepEqual(rejected.json(), { error: "invalid_request", message: entry.message });
      }

      const missing = await app.inject({
        method: "POST",
        url: "/runs",
        payload: { agent_id: "not-registered", phase: "baseline", task_ids: ["T1"] },
      });
      assert.equal(missing.statusCode, 404);
      assert.deepEqual(missing.json(), { error: "not_found", message: "No agent not-registered" });

      const listed = await app.inject({ method: "GET", url: "/runs" });
      assert.equal(listed.statusCode, 200);
      assert.deepEqual(listed.json().runs, []);
    } finally {
      await app.close();
    }
  });
});
