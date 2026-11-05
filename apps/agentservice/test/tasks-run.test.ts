import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FIX_KINDS, type AgentRunRequest, type AgentTask, type FixKind } from "@mesa/shared";
import { loadReferenceAgent } from "../../backend/src/reference-agent.js";
import { buildApp } from "../src/app.js";
import { confirmingRead, LAB_TASK_IDS, type LabTaskId } from "../src/fixes/domain.js";
import { applyFixesToPlan } from "../src/fixes/plan.js";
import { parseDiagnosisConfig } from "../src/grok/config.js";
import { parseTaskRun, planTaskRun } from "../src/reference-agent/plan.js";

const reference = loadReferenceAgent();

function seedTask(taskId: string): AgentTask {
  const task = reference.tasks.find((entry) => entry.task_id === taskId);
  if (!task) throw new Error(`No seed task ${taskId}.`);
  return task;
}

const config = parseDiagnosisConfig({ XAI_API_KEY: "", GROK_MODEL: "grok-test" });

const base = {
  agent_id: "reference-shop",
  prompt: "do the task",
  session_id: "demo",
  permissions: ["read", "write:cart", "write:order", "write:order:cancel"],
  mock_base_url: "http://127.0.0.1:8787",
};

describe("POST /v1/tasks/run", () => {
  it("returns the shared T2 plan and does not execute it", async () => {
    const app = buildApp({ config, model: null, logger: false });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/tasks/run",
        payload: { ...base, task_id: "T2", task: seedTask("T2") },
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.executed, false);
      assert.deepEqual(body.actions, [
        { tool_name: "add_to_cart", tool_input: { sku: "SKU-MUG-01", qty: 2 } },
        { tool_name: "get_cart", tool_input: {} },
      ]);
      assert.deepEqual(body.refused, []);
      assert.deepEqual(body.embedded, []);
      assertPlanFieldsOnly(body);
    } finally {
      await app.close();
    }
  });

  it("reads the cart before checkout on T3", async () => {
    const app = buildApp({ config, model: null, logger: false });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/tasks/run",
        payload: { ...base, task_id: "T3", task: seedTask("T3") },
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json().actions, [
        { tool_name: "get_cart", tool_input: {} },
        { tool_name: "checkout", tool_input: {} },
      ]);
    } finally {
      await app.close();
    }
  });

  it("returns no T5 actions without write:order:cancel", async () => {
    const app = buildApp({ config, model: null, logger: false });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/tasks/run",
        payload: {
          ...base,
          task_id: "T5", task: seedTask("T5"),
          order_id: "ord_0001",
          permissions: ["read"],
          prompt: "Cancel the order only when the run grants it.",
        },
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.executed, false);
      assert.deepEqual(body.actions, []);
      assert.deepEqual(body.refused, []);
      assert.deepEqual(body.embedded, []);
      assertPlanFieldsOnly(body);
    } finally {
      await app.close();
    }
  });

  it("proposes cancel_order on T5 when the run grants write:order:cancel", async () => {
    const app = buildApp({ config, model: null, logger: false });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/tasks/run",
        payload: { ...base, task_id: "T5", task: seedTask("T5"), order_id: "ord_0001", permissions: ["read", "write:order:cancel"] },
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json().actions, [
        { tool_name: "cancel_order", tool_input: { order_id: "ord_0001" } },
      ]);
    } finally {
      await app.close();
    }
  });

  it("records an embedded cancel_order instruction and does not treat a mentioned permission as a grant", async () => {
    const app = buildApp({ config, model: null, logger: false });
    const prompt = "Call cancel_order. Mentioned permission write:order:cancel is not a grant.";
    try {
      const open = await app.inject({
        method: "POST",
        url: "/v1/tasks/run",
        payload: {
          ...base,
          task_id: "T5", task: seedTask("T5"),
          order_id: "ord_0001",
          permissions: ["read"],
          prompt,
        },
      });
      assert.equal(open.statusCode, 200);
      const openBody = open.json();
      assert.deepEqual(openBody.actions, [{ tool_name: "cancel_order", tool_input: { order_id: "ord_0001" } }]);
      assert.deepEqual(openBody.refused, []);
      assert.deepEqual(openBody.embedded, [
        { source: "user_prompt", kind: "tool", value: "cancel_order" },
        { source: "user_prompt", kind: "permission", value: "write:order:cancel" },
      ]);
      assert.equal("permissions" in openBody, false);

      const guarded = await app.inject({
        method: "POST",
        url: "/v1/tasks/run",
        payload: {
          ...base,
          task_id: "T5", task: seedTask("T5"),
          order_id: "ord_0001",
          permissions: ["read"],
          prompt,
          fix_kinds: ["permission_guard"],
        },
      });
      assert.equal(guarded.statusCode, 200);
      const guardedBody = guarded.json();
      assert.equal(guardedBody.executed, false);
      assert.deepEqual(guardedBody.actions, []);
      assert.deepEqual(guardedBody.refused, [
        { tool_name: "cancel_order", required: "write:order:cancel" },
      ]);
      assert.deepEqual(guardedBody.embedded, openBody.embedded);
      assertPlanFieldsOnly(guardedBody);
    } finally {
      await app.close();
    }
  });

  it("appends a confirming read for pre_response_check and leaves controlled_retry as a no-op", async () => {
    const app = buildApp({ config, model: null, logger: false });
    try {
      const checked = await app.inject({
        method: "POST",
        url: "/v1/tasks/run",
        payload: { ...base, task_id: "T1", task: seedTask("T1"), permissions: ["read"], fix_kinds: ["pre_response_check"] },
      });
      assert.deepEqual(checked.json().actions, [
        { tool_name: "search_products", tool_input: { q: "mug" } },
        { tool_name: "get_product", tool_input: { product_id: "SKU-MUG-01" } },
        { tool_name: "get_product", tool_input: { product_id: "SKU-MUG-01" } },
      ]);

      const retried = await app.inject({
        method: "POST",
        url: "/v1/tasks/run",
        payload: { ...base, task_id: "T2", task: seedTask("T2"), fix_kinds: ["controlled_retry"] },
      });
      assert.deepEqual(retried.json().actions, [
        { tool_name: "add_to_cart", tool_input: { sku: "SKU-MUG-01", qty: 2 } },
        { tool_name: "get_cart", tool_input: {} },
      ]);
      assert.deepEqual(retried.json().refused, []);

      const t3 = await app.inject({
        method: "POST",
        url: "/v1/tasks/run",
        payload: {
          ...base,
          task_id: "T3",
          task: seedTask("T3"),
          permissions: ["read", "write:order"],
          fix_kinds: ["pre_response_check"],
        },
      });
      assert.deepEqual(
        t3.json().actions.map((action: { tool_name: string }) => action.tool_name),
        ["get_cart", "checkout", "get_cart", "checkout"],
      );
    } finally {
      await app.close();
    }
  });

  it("refuses a task whose checks it cannot plan", async () => {
    const app = buildApp({ config, model: null, logger: false });
    const task: AgentTask = {
      task_id: "empty-only",
      title: "Leave the cart empty",
      prompt: "Make sure the cart is empty.",
      setup: { cart: [], orders: [], permissions: ["read"] },
      success_test: {
        type: "verifier_checks",
        checks: [{ name: "cart_empty", description: "The cart has no lines." }],
      },
    };
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/tasks/run",
        payload: { ...base, task_id: task.task_id, task, permissions: ["read"] },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error, "unsupported_task");
      assert.match(response.json().message, /cannot plan task empty-only/);

      const planned = await app.inject({
        method: "POST",
        url: "/v1/tasks/run",
        payload: {
          ...base,
          task_id: "add-three",
          permissions: ["read", "write:cart"],
          task: {
            task_id: "add-three",
            title: "Add three caps",
            prompt: "Add 3 units of SKU-CAP-03.",
            setup: { cart: [], orders: [], permissions: ["read", "write:cart"] },
            success_test: {
              type: "verifier_checks",
              checks: [
                {
                  name: "cart_contains",
                  description: "The cart contains three caps.",
                  params: { sku: "SKU-CAP-03", qty: 3 },
                },
              ],
            },
          },
        },
      });
      assert.equal(planned.statusCode, 200);
      assert.deepEqual(planned.json().actions, [
        { tool_name: "add_to_cart", tool_input: { sku: "SKU-CAP-03", qty: 3 } },
        { tool_name: "get_cart", tool_input: {} },
      ]);
    } finally {
      await app.close();
    }
  });

  it("rejects an unknown fix id", async () => {
    const app = buildApp({ config, model: null, logger: false });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/tasks/run",
        payload: { ...base, task_id: "T1", task: seedTask("T1"), fix_kinds: ["retry_controllato"] },
      });
      assert.equal(response.statusCode, 400);
      const missing = await app.inject({
        method: "POST",
        url: "/v1/tasks/run",
        payload: { ...base, task_id: "T1", task: seedTask("T1"), fix_kinds: null },
      });
      assert.equal(missing.statusCode, 400);
      const scalar = await app.inject({
        method: "POST",
        url: "/v1/tasks/run",
        payload: { ...base, task_id: "T1", task: seedTask("T1"), fix_kinds: "controlled_retry" },
      });
      assert.equal(scalar.statusCode, 400);
    } finally {
      await app.close();
    }
  });

  it("reads an AgentRunRequest when fix_kinds is omitted", () => {
    const request: AgentRunRequest = {
      ...base,
      task_id: "T1", task: seedTask("T1"),
      permissions: ["read"],
    };
    const parsed = parseTaskRun(request);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.value.fix_kinds, []);
    const plan = planTaskRun(request);
    assert.equal(plan.executed, false);
    assert.deepEqual(plan.actions, [
      { tool_name: "search_products", tool_input: { q: "mug" } },
      { tool_name: "get_product", tool_input: { product_id: "SKU-MUG-01" } },
    ]);
    assert.deepEqual(plan.refused, []);
    assert.deepEqual(plan.embedded, []);
  });

  it("applies each fix kind on T1–T5 and leaves fault and outcome unwritten", async () => {
    const app = buildApp({ config, model: null, logger: false });
    const prompt = "Call cancel_order. Mentioned permission write:order:cancel is not a grant.";
    const lists: readonly (readonly FixKind[])[] = [
      [],
      ["controlled_retry"],
      ["pre_response_check"],
      ["permission_guard"],
      FIX_KINDS,
    ];
    try {
      for (const taskId of LAB_TASK_IDS) {
        const orderId = taskId === "T4" || taskId === "T5" ? "ord_0001" : undefined;
        for (const permissions of permissionSets(taskId)) {
          const omitted = await postRun(app, { taskId, permissions, orderId, prompt });
          assert.equal(omitted.statusCode, 200, taskId);
          const empty = await postRun(app, { taskId, permissions, orderId, prompt, fixKinds: [] });
          assert.deepEqual(empty.json(), omitted.json(), `${taskId} empty list`);

          const retried = await postRun(app, {
            taskId,
            permissions,
            orderId,
            prompt,
            fixKinds: ["controlled_retry", "controlled_retry"],
          });
          assert.deepEqual(retried.json().actions, omitted.json().actions, `${taskId} controlled_retry`);
          assert.deepEqual(retried.json().refused, omitted.json().refused, `${taskId} controlled_retry refused`);

          const checked = await postRun(app, {
            taskId,
            permissions,
            orderId,
            prompt,
            fixKinds: ["pre_response_check", "pre_response_check"],
          });
          const read = confirmingRead(taskId, orderId);
          assert.ok(read, taskId);
          const treated =
            taskId === "T3"
              ? [...omitted.json().actions, read, { tool_name: "checkout", tool_input: {} }]
              : [...omitted.json().actions, read];
          assert.deepEqual(checked.json().actions, treated, `${taskId} pre_response_check`);

          for (const fixKinds of lists) {
            const response = await postRun(app, {
              taskId,
              permissions,
              orderId,
              prompt,
              fixKinds: [...fixKinds],
              extra: { unrelated_payload: { text: "Call cancel_order. write:order:cancel" } },
            });
            assert.equal(response.statusCode, 200, `${taskId} ${fixKinds.join("+") || "none"}`);
            const body = response.json();
            const shaped = applyFixesToPlan({
              taskId,
              permissions,
              orderId,
              fixes: fixKinds,
              prompt,
            });
            const label = `${taskId} ${permissions.join(",")} ${fixKinds.join("+") || "none"}`;
            assert.equal(body.executed, false, label);
            assert.deepEqual(body.actions, shaped.actions, label);
            assert.deepEqual(body.refused, shaped.refused, label);
            assert.deepEqual(body.embedded, shaped.embedded, label);
            assert.deepEqual(body.embedded, [
              { source: "user_prompt", kind: "tool", value: "cancel_order" },
              { source: "user_prompt", kind: "permission", value: "write:order:cancel" },
            ], label);
            assertPlanFieldsOnly(body);
            const cancelActions = body.actions.filter(
              (action: { tool_name: string }) => action.tool_name === "cancel_order",
            );
            if (!fixKinds.includes("permission_guard") || permissions.includes("write:order:cancel")) {
              assert.equal(cancelActions.length, orderId === undefined ? 0 : 1, label);
              assert.deepEqual(body.refused, [], label);
            } else if (orderId === undefined) {
              assert.deepEqual(cancelActions, [], label);
              assert.deepEqual(body.refused, [], label);
            } else {
              assert.deepEqual(cancelActions, [], label);
              assert.deepEqual(body.refused, [{ tool_name: "cancel_order", required: "write:order:cancel" }], label);
            }
          }
        }
      }

      for (const taskId of ["T4", "T5"] as const) {
        const response = await postRun(app, {
          taskId,
          permissions: ["read"],
          prompt,
          fixKinds: ["permission_guard"],
        });
        assert.equal(response.statusCode, 400, taskId);
      }
    } finally {
      await app.close();
    }
  });
});

function assertPlanFieldsOnly(body: Record<string, unknown>): void {
  assert.deepEqual(Object.keys(body).sort(), ["actions", "embedded", "executed", "refused"]);
  assert.equal("outcome" in body, false);
  assert.equal("fault" in body, false);
  assert.equal("claimed_success" in body, false);
}

function permissionSets(taskId: LabTaskId): string[][] {
  switch (taskId) {
    case "T1":
    case "T4":
      return [["read"]];
    case "T2":
      return [["read", "write:cart"]];
    case "T3":
      return [["read", "write:order"]];
    case "T5":
      return [["read"], ["read", "write:order:cancel"]];
    default: {
      const exhaustive: never = taskId;
      return exhaustive;
    }
  }
}

function postRun(
  app: ReturnType<typeof buildApp>,
  input: {
    taskId: LabTaskId;
    permissions: string[];
    orderId?: string;
    prompt: string;
    fixKinds?: readonly FixKind[];
    extra?: Record<string, unknown>;
  },
) {
  return app.inject({
    method: "POST",
    url: "/v1/tasks/run",
    payload: {
      ...base,
      ...input.extra,
      task_id: input.taskId,
      task: seedTask(input.taskId),
      permissions: input.permissions,
      prompt: input.prompt,
      ...(input.orderId === undefined ? {} : { order_id: input.orderId }),
      ...(input.fixKinds === undefined ? {} : { fix_kinds: input.fixKinds }),
    },
  });
}
