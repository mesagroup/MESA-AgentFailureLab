import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { TraceStep } from "@mesa/shared";
import { validateRun, validateTrace } from "@mesa/shared/validate";
import { LIBRARY_AGENT_ID, MemoryAgentStore } from "../src/agents/store.js";
import { runTasks } from "../src/harness/runner.js";
import { createHttpMockClient } from "../src/mock/client.js";
import { MemoryStore } from "../src/persistence/memory.js";
import { loadLibraryAgent } from "../src/reference-agent.js";
import { startLibrary } from "./helpers.js";

function toolCalls(steps: readonly TraceStep[]): string[] {
  return steps.flatMap((step) => (step.type === "tool_call" && step.tool_name ? [step.tool_name] : []));
}

describe("library desk seed", { concurrency: false }, () => {
  let baseUrl = "";
  let closeLibrary: () => Promise<void> = async () => {};

  before(async () => {
    const library = await startLibrary();
    baseUrl = library.baseUrl;
    closeLibrary = library.close;
  });

  after(async () => {
    await closeLibrary();
  });

  it("passes renew-loan, return-loan, and place-hold on the library mock", async () => {
    const agent = loadLibraryAgent();
    assert.equal(agent.agent_id, LIBRARY_AGENT_ID);
    assert.equal(agent.instance.kind, "external");
    assert.equal(agent.world?.kind, "library");
    assert.deepEqual(
      agent.tasks.map((task) => task.task_id),
      ["renew-loan", "return-loan", "place-hold"],
    );
    const store = new MemoryStore();
    const results = await runTasks({
      agent,
      store,
      mock: createHttpMockClient(baseUrl),
      mockBaseUrl: baseUrl,
      phase: "baseline",
      driver: "scripted",
    });
    assert.deepEqual(
      results.map((result) => result.run.task_id),
      ["renew-loan", "return-loan", "place-hold"],
    );
    for (const result of results) {
      assert.ok(result.trace);
      assert.equal(result.run.status, "passed");
      assert.equal(result.trace.outcome.verifier.passed, true);
      assert.equal(result.trace.outcome.verifier.checks.some((check) => check.name.startsWith("cart_")), false);
      assert.equal(validateRun(result.run).ok, true);
      assert.equal(validateTrace(result.trace).ok, true);
      assert.equal(Object.hasOwn(result.trace, "phase"), false);
      assert.equal(Object.hasOwn(result.trace, "fix_kinds"), false);
    }
    const [renew, returned, hold] = results;
    assert.ok(renew?.trace && returned?.trace && hold?.trace);
    assert.deepEqual(toolCalls(renew.trace.steps), ["renew_loan", "get_loan"]);
    assert.deepEqual(toolCalls(returned.trace.steps), ["return_loan", "get_loan"]);
    assert.deepEqual(toolCalls(hold.trace.steps), ["place_hold"]);
  });

  // #189 hero reliability: forged renew_loan vs mock renewals: 0.
  // Callers: none (test only). Schema: Run/Trace + fault.labels forged_tool_result.
  it("fails renew-loan when forged_tool_result claims renewals: 1 but the mock stays at 0", async () => {
    const agent = loadLibraryAgent();
    const store = new MemoryStore();
    const [result] = await runTasks({
      agent,
      store,
      mock: createHttpMockClient(baseUrl),
      mockBaseUrl: baseUrl,
      phase: "injected",
      taskIds: ["renew-loan"],
      driver: "scripted",
    });
    assert.ok(result?.trace);
    assert.equal(result.run.status, "failed");
    assert.equal(result.run.injection_plan?.ground_truth.code, "forged_tool_result");
    assert.equal(result.run.injection_plan?.target, "renew_loan");
    assert.equal(result.trace.fault.labels[0]?.code, "forged_tool_result");
    assert.equal(result.trace.outcome.verifier.passed, false);
    assert.equal(
      result.trace.outcome.verifier.checks.some((check) => check.name === "loan_renewed" && !check.passed),
      true,
    );
    assert.equal(result.trace.outcome.agent_claimed_success, true);
    const renewResult = result.trace.steps.find(
      (step) => step.type === "tool_result" && step.tool_name === "renew_loan",
    );
    assert.ok(renewResult);
    assert.equal((renewResult.tool_output as { renewals?: number }).renewals, 1);
  });

  it("keeps an edited library seed and rewrites an older or invalid one", async () => {
    const older = loadLibraryAgent();
    older.name = "Old desk";
    older.updated_at = "2020-01-01T00:00:00.000Z";
    const rewritten = new MemoryAgentStore([older]);
    assert.equal((await rewritten.get(LIBRARY_AGENT_ID))?.name, "Library desk");

    const agents = new MemoryAgentStore();
    const current = loadLibraryAgent();
    current.name = "Kept desk";
    current.description = "Edited after the fixture.";
    current.tasks[2]!.title = "Edited hold";
    await agents.replace(LIBRARY_AGENT_ID, current);
    const report = await agents.seedIfMissing();
    assert.equal(report[LIBRARY_AGENT_ID], "kept");
    const kept = await agents.get(LIBRARY_AGENT_ID);
    assert.equal(kept?.name, "Kept desk");
    assert.equal(kept?.tasks[2]?.title, "Edited hold");

    const broken = loadLibraryAgent() as unknown as Record<string, unknown>;
    const tasks = broken.tasks as Array<Record<string, unknown>>;
    delete tasks[0]?.setup;
    broken.updated_at = "2099-01-01T00:00:00.000Z";
    agents.putRawForTests(broken);
    const healed = await agents.seedIfMissing();
    assert.equal(healed[LIBRARY_AGENT_ID], "refreshed");
    assert.equal((await agents.get(LIBRARY_AGENT_ID))?.name, "Library desk");
    assert.ok((await agents.get(LIBRARY_AGENT_ID))?.tasks[0]?.setup);
    await rewritten.close();
    await agents.close();
  });
});
