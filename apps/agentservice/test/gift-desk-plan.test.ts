import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentTask } from "@mesa/shared";
import { loadGiftDeskAgent } from "../../backend/src/reference-agent.js";
import { buildApp } from "../src/app.js";
import { parseDiagnosisConfig } from "../src/grok/config.js";

const gift = loadGiftDeskAgent();
const config = parseDiagnosisConfig({ XAI_API_KEY: "", GROK_MODEL: "grok-test" });

function task(taskId: string): AgentTask {
  const found = gift.tasks.find((entry) => entry.task_id === taskId);
  if (!found) throw new Error(`missing ${taskId}`);
  return found;
}

describe("gift desk tasks on POST /v1/tasks/run", () => {
  it("returns a plan for each gift desk task", async () => {
    const app = buildApp({ config, model: null, logger: false });
    try {
      const cases = [
        {
          task: task("compare-products"),
          permissions: ["read"],
          actions: [
            { tool_name: "search_products", tool_input: { q: "notebook" } },
            { tool_name: "get_product", tool_input: { product_id: "SKU-NOTE-05" } },
            { tool_name: "get_product", tool_input: { product_id: "SKU-BAG-04" } },
          ],
        },
        {
          task: task("correct-quantity"),
          permissions: ["read", "write:cart"],
          actions: [
            { tool_name: "update_cart", tool_input: { sku: "SKU-NOTE-05", qty: 1 } },
            { tool_name: "get_cart", tool_input: {} },
          ],
        },
        {
          task: task("clear-cart"),
          permissions: ["read", "write:cart"],
          actions: [
            { tool_name: "update_cart", tool_input: { sku: "SKU-TEE-02", qty: 0 } },
            { tool_name: "update_cart", tool_input: { sku: "SKU-MUG-01", qty: 0 } },
            { tool_name: "get_cart", tool_input: {} },
          ],
        },
      ];
      for (const entry of cases) {
        const response = await app.inject({
          method: "POST",
          url: "/v1/tasks/run",
          payload: {
            agent_id: gift.agent_id,
            task_id: entry.task.task_id,
            task: entry.task,
            prompt: entry.task.prompt,
            session_id: "gift",
            permissions: entry.permissions,
            mock_base_url: "http://127.0.0.1:8787",
          },
        });
        assert.equal(response.statusCode, 200, response.body);
        const body = response.json();
        assert.equal(body.executed, false);
        assert.deepEqual(body.actions, entry.actions);
        assert.deepEqual(body.refused, []);
      }
    } finally {
      await app.close();
    }
  });

  it("refuses a task whose checks are not a known pattern", async () => {
    const app = buildApp({ config, model: null, logger: false });
    try {
      const unknown = structuredClone(task("clear-cart"));
      unknown.task_id = "order-only";
      unknown.success_test.checks = [{ name: "order_created", description: "An order exists." }];
      const response = await app.inject({
        method: "POST",
        url: "/v1/tasks/run",
        payload: {
          agent_id: gift.agent_id,
          task_id: unknown.task_id,
          task: unknown,
          prompt: unknown.prompt,
          session_id: "gift",
          permissions: ["read", "write:order"],
          mock_base_url: "http://127.0.0.1:8787",
        },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error, "unsupported_task");
    } finally {
      await app.close();
    }
  });
});
