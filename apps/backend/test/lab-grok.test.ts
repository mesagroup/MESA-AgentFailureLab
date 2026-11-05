import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { TASK_FAULT_PRESETS } from "../src/injector/catalog.js";
import { runTasks } from "../src/harness/runner.js";
import { createHttpMockClient } from "../src/mock/client.js";
import { MemoryStore } from "../src/persistence/memory.js";
import { loadReferenceAgent } from "../src/reference-agent.js";
import { startMockShop } from "./helpers.js";

const reference = loadReferenceAgent();

describe("lab grok planner", { concurrency: false }, () => {
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

  it("stamps model usage on a T1 http run and keeps scripted totals at zero tokens", async () => {
    const store = new MemoryStore();
    const mock = createHttpMockClient(baseUrl);
    const [grok] = await runTasks({
      agent: reference,
      store,
      mock,
      mockBaseUrl: baseUrl,
      phase: "baseline",
      taskIds: ["T1"],
      driver: "http",
      planner: "grok",
      callAgent: async () => ({
        executed: false,
        actions: [
          { tool_name: "search_products", tool_input: { q: "mug" } },
          { tool_name: "get_product", tool_input: { product_id: "SKU-MUG-01" } },
        ],
        answer: "Opened the mug.",
        usage: { input_tokens: 40, output_tokens: 8, cost_usd: 0.005, latency_ms: 500 },
        agent: "grok",
      }),
    });
    assert.ok(grok?.trace);
    assert.ok(grok.trace.totals.tokens_in >= 40);
    assert.ok(grok.trace.totals.tokens_out >= 8);
    assert.ok(grok.trace.totals.cost_usd >= 0.005);
    assert.ok(grok.trace.totals.latency_ms >= 500);
    assert.equal(grok.trace.diagnosis, null);

    const [scripted] = await runTasks({
      agent: reference,
      store,
      mock,
      mockBaseUrl: baseUrl,
      phase: "baseline",
      taskIds: ["T1"],
      driver: "scripted",
    });
    assert.ok(scripted?.trace);
    assert.equal(scripted.trace.totals.tokens_in, 0);
    assert.equal(scripted.trace.totals.tokens_out, 0);
    assert.equal(scripted.trace.totals.cost_usd, 0);
  });

  it("still applies the T1 catalog fault when the planner is grok", async () => {
    const [injected] = await runTasks({
      agent: reference,
      store: new MemoryStore(),
      mock: createHttpMockClient(baseUrl),
      mockBaseUrl: baseUrl,
      phase: "injected",
      taskIds: ["T1"],
      driver: "http",
      planner: "grok",
      callAgent: async () => ({
        executed: false,
        actions: [
          { tool_name: "search_products", tool_input: { q: "mug" } },
          { tool_name: "get_product", tool_input: { product_id: "SKU-MUG-01" } },
        ],
        usage: { input_tokens: 4, output_tokens: 1, cost_usd: 0.001, latency_ms: 20 },
        agent: "grok",
      }),
    });
    assert.equal(injected?.trace?.fault.injected, true);
    assert.equal(injected?.trace?.fault.labels[0]?.code, TASK_FAULT_PRESETS.T1);
    assert.equal(injected?.trace?.diagnosis, null);
  });
});
