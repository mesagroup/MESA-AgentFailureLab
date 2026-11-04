import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Agent, AgentTask } from "@mesa/shared";
import { validateAgent } from "@mesa/shared/validate";
import { buildApp } from "../src/app.js";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/shared/examples/agent-library-desk.json");
const parsed: unknown = JSON.parse(readFileSync(fixturePath, "utf8"));
const agentResult = validateAgent(parsed);
if (!agentResult.ok) throw new Error(agentResult.errors.join("; "));
const agent: Agent = agentResult.value;

function task(taskId: string): AgentTask {
  const found = agent.tasks.find((entry) => entry.task_id === taskId);
  if (!found) throw new Error(taskId);
  return found;
}

describe("library desk POST /v1/tasks/run", () => {
  it("plans renew, return, and hold, and refuses a shop check", async () => {
    const app = buildApp();
    try {
      const renew = await app.inject({
        method: "POST",
        url: "/v1/tasks/run",
        payload: {
          agent_id: agent.agent_id,
          task_id: "renew-loan",
          task: task("renew-loan"),
          prompt: task("renew-loan").prompt,
          session_id: "lib",
          permissions: ["read", "write:loan"],
          mock_base_url: "http://127.0.0.1:8788",
        },
      });
      assert.equal(renew.statusCode, 200);
      assert.equal(renew.json().executed, false);
      assert.deepEqual(renew.json().actions, [
        { tool_name: "renew_loan", tool_input: { loan_id: "loan-1042" } },
        { tool_name: "get_loan", tool_input: { loan_id: "loan-1042" } },
      ]);

      const guarded = await app.inject({
        method: "POST",
        url: "/v1/tasks/run",
        payload: {
          agent_id: agent.agent_id,
          task_id: "return-loan",
          task: task("return-loan"),
          prompt: task("return-loan").prompt,
          session_id: "lib",
          permissions: ["read"],
          mock_base_url: "http://127.0.0.1:8788",
          fix_kinds: ["permission_guard"],
        },
      });
      assert.equal(guarded.statusCode, 200);
      assert.deepEqual(guarded.json().actions, [{ tool_name: "get_loan", tool_input: { loan_id: "loan-1042" } }]);
      assert.deepEqual(guarded.json().refused, [{ tool_name: "return_loan", required: "write:loan" }]);

      const shop = structuredClone(task("place-hold"));
      shop.task_id = "shop-check";
      shop.success_test.checks = [{ name: "cart_empty", description: "The cart is empty." }];
      const refused = await app.inject({
        method: "POST",
        url: "/v1/tasks/run",
        payload: {
          agent_id: agent.agent_id,
          task_id: "shop-check",
          task: shop,
          prompt: "empty",
          session_id: "lib",
          permissions: ["read"],
          mock_base_url: "http://127.0.0.1:8788",
        },
      });
      assert.equal(refused.statusCode, 400);
      assert.equal(refused.json().error, "unsupported_task");
    } finally {
      await app.close();
    }
  });
});
