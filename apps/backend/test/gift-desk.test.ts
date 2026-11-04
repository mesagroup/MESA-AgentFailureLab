import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { TraceStep } from "@mesa/shared";
import { validateRun, validateTrace } from "@mesa/shared/validate";
import { GIFT_DESK_AGENT_ID, MemoryAgentStore } from "../src/agents/store.js";
import { runTasks } from "../src/harness/runner.js";
import { createHttpMockClient } from "../src/mock/client.js";
import { MemoryStore } from "../src/persistence/memory.js";
import { loadGiftDeskAgent } from "../src/reference-agent.js";
import { startMockShop } from "./helpers.js";

function toolCalls(steps: readonly TraceStep[]): string[] {
  return steps.flatMap((step) => (step.type === "tool_call" && step.tool_name ? [step.tool_name] : []));
}

describe("gift desk seed", { concurrency: false }, () => {
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

  it("passes compare-products, correct-quantity, and clear-cart on the mock shop", async () => {
    const agent = loadGiftDeskAgent();
    assert.equal(agent.agent_id, GIFT_DESK_AGENT_ID);
    assert.deepEqual(
      agent.tasks.map((task) => task.task_id),
      ["compare-products", "correct-quantity", "clear-cart"],
    );
    const store = new MemoryStore();
    const results = await runTasks({
      agent,
      store,
      mock: createHttpMockClient(baseUrl),
      mockBaseUrl: baseUrl,
      phase: "baseline",
    });
    assert.deepEqual(
      results.map((result) => result.run.task_id),
      ["compare-products", "correct-quantity", "clear-cart"],
    );
    for (const result of results) {
      assert.ok(result.trace);
      assert.equal(result.run.status, "passed");
      assert.equal(result.trace.outcome.verifier.passed, true);
      assert.equal(validateRun(result.run).ok, true);
      assert.equal(validateTrace(result.trace).ok, true);
    }
    const [compare, correct, clear] = results;
    assert.ok(compare?.trace && correct?.trace && clear?.trace);
    assert.deepEqual(toolCalls(compare.trace.steps), ["search_products", "get_product", "get_product"]);
    assert.deepEqual(toolCalls(correct.trace.steps), ["update_cart", "get_cart"]);
    assert.deepEqual(toolCalls(clear.trace.steps), ["update_cart", "update_cart", "get_cart"]);
    assert.equal(
      clear.trace.steps.some((step) => step.tool_name === "checkout"),
      false,
    );
  });

  it("rewrites a gift-desk row that is older or invalid and keeps a newer edit", async () => {
    const older = loadGiftDeskAgent();
    older.name = "Old desk";
    older.updated_at = "2020-01-01T00:00:00.000Z";
    const rewritten = new MemoryAgentStore([older]);
    assert.equal((await rewritten.get(GIFT_DESK_AGENT_ID))?.name, "Gift desk assistant");

    const agents = new MemoryAgentStore();
    const current = loadGiftDeskAgent();
    current.name = "Kept desk";
    current.description = "Edited after the fixture.";
    current.tasks[2]!.title = "Edited clear";
    await agents.replace(GIFT_DESK_AGENT_ID, current);
    const report = await agents.seedIfMissing();
    assert.equal(report[GIFT_DESK_AGENT_ID], "kept");
    const kept = await agents.get(GIFT_DESK_AGENT_ID);
    assert.equal(kept?.name, "Kept desk");
    assert.equal(kept?.description, "Edited after the fixture.");
    assert.equal(kept?.tasks[2]?.title, "Edited clear");

    const broken = loadGiftDeskAgent() as unknown as Record<string, unknown>;
    const tasks = broken.tasks as Array<Record<string, unknown>>;
    delete tasks[0]?.setup;
    broken.updated_at = "2099-01-01T00:00:00.000Z";
    agents.putRawForTests(broken);
    const healed = await agents.seedIfMissing();
    assert.equal(healed[GIFT_DESK_AGENT_ID], "refreshed");
    assert.equal((await agents.get(GIFT_DESK_AGENT_ID))?.name, "Gift desk assistant");
    assert.ok((await agents.get(GIFT_DESK_AGENT_ID))?.tasks[0]?.setup);
    await rewritten.close();
    await agents.close();
  });
});
