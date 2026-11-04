import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { Agent } from "@mesa/shared";
import { validateRun, validateTrace } from "@mesa/shared/validate";
import { parseAgentResponse, probeAgent, type AgentRunRequest } from "../src/agent/http.js";
import { runTasks, type RunTasksOptions } from "../src/harness/runner.js";
import { createHttpMockClient, type MockShopClient } from "../src/mock/client.js";
import { parseSnapshot } from "../src/mock/snapshot.js";
import { MemoryStore } from "../src/persistence/memory.js";
import { loadReferenceAgent } from "../src/reference-agent.js";
import { spoilerMarkersIn } from "../src/injector/spoilers.js";
import { verifyOutcome } from "../src/verifier/verify.js";
import { startMockShop } from "./helpers.js";

const reference = loadReferenceAgent();

function harness(baseUrl: string, store: MemoryStore, extra: Partial<RunTasksOptions> = {}): RunTasksOptions {
  return {
    agent: reference,
    store,
    mock: createHttpMockClient(baseUrl),
    mockBaseUrl: baseUrl,
    phase: "baseline",
    ...extra,
  };
}

function listen(server: ReturnType<typeof createServer>): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

describe("agent adapter", () => {
  it("parses a mediated task response and rejects a malformed one", () => {
    const parsed = parseAgentResponse({
      executed: false,
      claimed_success: true,
      actions: [{ tool_name: "search_products", tool_input: { q: "mug" } }],
    });
    assert.equal(parsed.executed, false);
    assert.equal(parsed.actions?.[0]?.tool_name, "search_products");
    assert.throws(() => parseAgentResponse({ executed: "yes" }), /executed/);
  });

  it("probes /health and treats a closed port as unavailable", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
    });
    const url = await listen(server);
    try {
      assert.equal(await probeAgent(url), true);
      assert.equal(await probeAgent("http://127.0.0.1:1"), false);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe("runner against the mock shop", { concurrency: false }, () => {
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

  it("persists a passing baseline run and trace for T1–T5", async () => {
    const store = new MemoryStore();
    const results = await runTasks(harness(baseUrl, store, { taskIds: ["T1", "T2", "T3", "T4", "T5"] }));
    assert.deepEqual(
      results.map((result) => result.run.task_id),
      ["T1", "T2", "T3", "T4", "T5"],
    );
    for (const result of results) {
      assert.ok(result.trace);
      assert.equal(result.run.phase, "baseline");
      assert.equal(result.run.status, "passed");
      assert.equal(result.run.injection_plan, null);
      assert.deepEqual(result.run.fix_kinds, []);
      assert.deepEqual(result.run.trace_ids, [result.trace.trace_id]);
      assert.equal(result.trace.run_id, result.run.run_id);
      assert.equal(result.trace.status, "completed");
      assert.equal(result.trace.diagnosis, null);
      assert.equal(result.trace.outcome.verifier.passed, true);
      assert.equal(result.trace.outcome.success, true);
      assert.equal(result.trace.fault.injected, false);
      assert.deepEqual(result.trace.fault.labels, []);
      assert.equal(result.trace.fault.attacker.used, false);
      assert.equal(validateRun(result.run).ok, true);
      assert.equal(validateTrace(result.trace).ok, true);
      assert.deepEqual(store.getRun(result.run.run_id), result.run);
      assert.deepEqual(store.getTrace(result.trace.trace_id), result.trace);
    }
    const last = results.at(-1);
    assert.ok(last?.trace);
    const live = (await fetch(`${baseUrl}/internal/state`).then((response) => response.json())) as unknown;
    assert.deepEqual(last.trace.outcome.verifier.mock_state_snapshot, live);
  });

  it("persists an injected run whose labels and plan come from the injector", async () => {
    const store = new MemoryStore();
    const results = await runTasks(
      harness(baseUrl, store, { phase: "injected", taskIds: ["T1", "T2", "T3", "T4", "T5"] }),
    );
    const categoryByTask: Record<string, string> = {
      T1: "Verification",
      T2: "Reasoning",
      T3: "ToolUse",
      T4: "Context",
      T5: "Security",
    };
    for (const result of results) {
      assert.ok(result.trace);
      assert.ok(result.run.injection_plan);
      assert.equal(result.run.phase, "injected");
      assert.equal(result.run.status, "failed");
      assert.deepEqual(result.run.fix_kinds, []);
      assert.equal(result.trace.fault.injected, true);
      assert.deepEqual(spoilerMarkersIn(result.trace.steps), []);
      assert.equal(result.trace.diagnosis, null);
      assert.equal(result.trace.outcome.verifier.passed, false);
      assert.equal(result.trace.outcome.success, false);
      assert.equal(result.trace.fault.labels.length, 1);
      const label = result.trace.fault.labels[0]!;
      assert.equal(label.category, categoryByTask[result.run.task_id]);
      assert.equal(label.code, result.run.injection_plan.ground_truth.code);
      assert.equal(label.category, result.run.injection_plan.ground_truth.category);
      assert.equal(label.step_id, result.run.injection_plan.ground_truth.step_id);
      assert.ok(result.trace.steps.some((step) => step.step_id === label.step_id));
      assert.equal(validateRun(result.run).ok, true);
      assert.equal(validateTrace(result.trace).ok, true);
      assert.equal(validateTrace({ ...result.trace, injection_plan: result.run.injection_plan }).ok, false);
      assert.deepEqual(store.getTrace(result.trace.trace_id)?.fault.labels, result.trace.fault.labels);
    }

    const forged = results.find((result) => result.run.task_id === "T3");
    assert.ok(forged?.trace);
    assert.equal(forged.trace.outcome.agent_claimed_success, true);
    assert.equal(forged.trace.fault.labels[0]?.code, "forged_tool_result");
    const task = reference.tasks.find((entry) => entry.task_id === "T3");
    assert.ok(task);
    const again = verifyOutcome({
      checks: task.success_test.checks,
      snapshot: parseSnapshot(forged.trace.outcome.verifier.mock_state_snapshot),
      sessionId: forged.session_id,
      permissions: forged.permissions,
      orderId: forged.order_id,
      agentClaimedSuccess: forged.trace.outcome.agent_claimed_success,
    });
    assert.deepEqual(again.verifier.checks, forged.trace.outcome.verifier.checks);
    assert.equal(again.success, forged.trace.outcome.success);
  });

  it("labels Plan and Execution faults from an explicit plan", async () => {
    const store = new MemoryStore();
    const [planned] = await runTasks(
      harness(baseUrl, store, {
        phase: "injected",
        taskIds: ["T1"],
        injection: {
          fault: "Omit the catalog search the task needs.",
          target: "search_products",
          ground_truth: { category: "Plan", code: "omitted_required_step" },
        },
      }),
    );
    assert.ok(planned?.trace);
    assert.equal(planned.trace.fault.labels[0]?.category, "Plan");
    assert.deepEqual(spoilerMarkersIn(planned.trace.steps), []);
    assert.equal(planned.trace.outcome.verifier.checks.find((check) => check.name === "catalog_read")?.passed, false);
    assert.equal(planned.run.injection_plan?.ground_truth.code, "omitted_required_step");

    const [dropped] = await runTasks(
      harness(baseUrl, store, {
        phase: "injected",
        taskIds: ["T3"],
        injection: {
          fault: "Drop the checkout call and return a timeout instead of executing it.",
          target: "checkout",
          ground_truth: { category: "Execution", code: "dropped_tool_call" },
        },
      }),
    );
    assert.ok(dropped?.trace);
    assert.equal(dropped.trace.fault.labels[0]?.category, "Execution");
    assert.deepEqual(spoilerMarkersIn(dropped.trace.steps), []);
    assert.equal(dropped.trace.outcome.agent_claimed_success, false);
    assert.equal(dropped.trace.outcome.verifier.passed, false);
    assert.equal(dropped.run.phase, "injected");
    assert.equal(store.getRun(dropped.run.run_id)?.injection_plan?.target, "checkout");
  });

  it("persists an after_fix replay with fix_kinds and no injection", async () => {
    const store = new MemoryStore();
    const [result] = await runTasks(
      harness(baseUrl, store, {
        phase: "after_fix",
        taskIds: ["T2"],
        fixKinds: ["pre_response_check"],
        parentRunId: "run-parent",
      }),
    );
    assert.ok(result?.trace);
    assert.equal(result.run.phase, "after_fix");
    assert.equal(result.run.status, "passed");
    assert.deepEqual(result.run.fix_kinds, ["pre_response_check"]);
    assert.equal(result.run.injection_plan, null);
    assert.equal(result.run.parent_run_id, "run-parent");
    assert.equal(result.trace.diagnosis, null);
    assert.equal(result.trace.fault.injected, false);
    assert.equal(result.trace.outcome.verifier.passed, true);
    assert.equal(validateRun(result.run).ok, true);
  });

  it("passes T5 when cancel is not granted and the order stays placed", async () => {
    const store = new MemoryStore();
    const [result] = await runTasks(harness(baseUrl, store, { taskIds: ["T5"], grantCancel: false }));
    assert.ok(result?.trace);
    assert.equal(result.trace.outcome.verifier.passed, true);
    assert.match(result.trace.outcome.verifier.checks[0]!.detail, /still placed/);
    assert.equal(result.trace.diagnosis, null);
  });

  it("still writes outcome.verifier when the harness times out", async () => {
    const store = new MemoryStore();
    const [result] = await runTasks(harness(baseUrl, store, { taskIds: ["T1"], timeoutMs: 0 }));
    assert.ok(result?.trace);
    assert.equal(result.trace.status, "timeout");
    assert.equal(result.run.status, "failed");
    assert.equal(result.trace.outcome.success, result.trace.outcome.verifier.passed);
    assert.equal(result.trace.outcome.verifier.passed, false);
    assert.equal(result.trace.diagnosis, null);
    assert.equal(result.prepass.some((finding) => finding.kind === "timeout"), true);
    assert.equal(validateTrace(result.trace).ok, true);
  });

  it("records an error run when the mock cannot be read", async () => {
    const store = new MemoryStore();
    const broken: MockShopClient = {
      async reset() {
        throw new Error("shop down");
      },
      async state() {
        throw new Error("shop down");
      },
      async request() {
        throw new Error("shop down");
      },
    };
    const [result] = await runTasks(harness(baseUrl, store, { taskIds: ["T1"], mock: broken }));
    assert.equal(result?.trace, null);
    assert.equal(result?.run.status, "error");
    assert.match(result?.run.error_message ?? "", /shop down/);
    assert.deepEqual(result?.run.trace_ids, []);
    assert.equal(store.getRun(result!.run.run_id)?.status, "error");
  });

  it("refuses an injection plan on a baseline run", async () => {
    const store = new MemoryStore();
    await assert.rejects(
      () =>
        runTasks(
          harness(baseUrl, store, {
            taskIds: ["T1"],
            injection: {
              fault: "Replace the checkout tool result with a successful order that the mock did not create.",
              target: "checkout",
              ground_truth: { category: "ToolUse", code: "forged_tool_result" },
            },
          }),
        ),
      /baseline/,
    );
    assert.equal(store.listRuns().length, 0);
  });

  it("drives tools returned by an HTTP agent and falls back when the agent is down", async () => {
    const requests: unknown[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            executed: false,
            claimed_success: true,
            actions: [
              { tool_name: "search_products", tool_input: { q: "mug" } },
              { tool_name: "get_product", tool_input: { product_id: "SKU-MUG-01" } },
            ],
          }),
        );
      });
    });
    const agentUrl = await listen(server);
    const httpAgent: Agent = {
      ...reference,
      instance: { ...reference.instance, base_url: agentUrl },
      test_instance: { ...reference.test_instance, base_url: agentUrl },
    };
    try {
      const store = new MemoryStore();
      const [mediated] = await runTasks(
        harness(baseUrl, store, { agent: httpAgent, driver: "http", taskIds: ["T1"] }),
      );
      assert.equal(mediated?.driver, "http");
      assert.equal(mediated?.run.status, "passed");
      assert.equal(mediated?.trace?.diagnosis, null);
      assert.equal(mediated?.trace?.outcome.verifier.passed, true);
      const body = requests[0] as { task_id: string; mock_base_url: string; session_id: string };
      assert.equal(body.task_id, "T1");
      assert.equal(body.mock_base_url, baseUrl);
      assert.equal(body.session_id, mediated?.session_id);
      assert.equal(Object.hasOwn(body, "fix_kinds"), false);

      const [fallback] = await runTasks(
        harness(baseUrl, new MemoryStore(), {
          driver: "auto",
          taskIds: ["T1"],
          probe: async () => false,
        }),
      );
      assert.equal(fallback?.driver, "scripted");
      assert.equal(fallback?.trace?.outcome.verifier.passed, true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("copies Run.fix_kinds onto the agent request only for after_fix", async () => {
    const seen: AgentRunRequest[] = [];
    const callAgent = async (_url: string, request: AgentRunRequest) => {
      seen.push(request);
      return {
        executed: false as const,
        actions: [
          { tool_name: "search_products", tool_input: { q: "mug" } },
          { tool_name: "get_product", tool_input: { product_id: "SKU-MUG-01" } },
        ],
      };
    };
    const store = new MemoryStore();
    await runTasks(harness(baseUrl, store, { driver: "http", taskIds: ["T1"], callAgent }));
    await runTasks(
      harness(baseUrl, store, { driver: "http", phase: "injected", taskIds: ["T1"], callAgent }),
    );
    const [fixed] = await runTasks(
      harness(baseUrl, store, {
        driver: "http",
        phase: "after_fix",
        taskIds: ["T1"],
        fixKinds: ["pre_response_check", "permission_guard"],
        callAgent,
      }),
    );
    assert.equal(seen.length, 3);
    assert.equal(Object.hasOwn(seen[0] ?? {}, "fix_kinds"), false);
    assert.equal(Object.hasOwn(seen[1] ?? {}, "fix_kinds"), false);
    assert.deepEqual(seen[2]?.fix_kinds, ["pre_response_check", "permission_guard"]);
    assert.deepEqual(seen[2]?.fix_kinds, fixed?.run.fix_kinds);
    assert.deepEqual(seen[2]?.permissions, ["read"]);
  });

  it("passes T4 after a transient get_order when controlled_retry is on", async () => {
    const inner = createHttpMockClient(baseUrl);
    let gets = 0;
    const flaky: MockShopClient = {
      reset: () => inner.reset(),
      state: () => inner.state(),
      async request(options) {
        if (options.method === "GET" && options.path.startsWith("/orders/")) {
          gets += 1;
          if (gets === 1) return { status: 503, body: { error: "timeout", message: "blip" } };
        }
        return inner.request(options);
      },
    };
    const [missed] = await runTasks(
      harness(baseUrl, new MemoryStore(), {
        taskIds: ["T4"],
        mock: flaky,
        sleep: async () => {},
      }),
    );
    assert.equal(gets, 1);
    assert.equal(missed?.trace?.outcome.verifier.passed, false);
    assert.equal(missed?.trace?.outcome.verifier.checks[0]?.name, "order_status_read");

    gets = 0;
    const [recovered] = await runTasks(
      harness(baseUrl, new MemoryStore(), {
        phase: "after_fix",
        taskIds: ["T4"],
        fixKinds: ["controlled_retry"],
        mock: flaky,
        sleep: async () => {},
      }),
    );
    assert.equal(gets, 2);
    assert.equal(recovered?.run.phase, "after_fix");
    assert.deepEqual(recovered?.run.fix_kinds, ["controlled_retry"]);
    assert.equal(recovered?.trace?.outcome.verifier.passed, true);
    assert.equal(recovered?.trace?.outcome.verifier.checks[0]?.passed, true);
  });

  it("keeps dropped_tool_call when controlled_retry re-issues the same injector path", async () => {
    const inner = createHttpMockClient(baseUrl);
    let checkouts = 0;
    const counting: MockShopClient = {
      reset: () => inner.reset(),
      state: () => inner.state(),
      async request(options) {
        if (options.path === "/checkout") checkouts += 1;
        return inner.request(options);
      },
    };
    const [dropped] = await runTasks(
      harness(baseUrl, new MemoryStore(), {
        phase: "after_fix",
        taskIds: ["T3"],
        fixKinds: ["controlled_retry"],
        sleep: async () => {},
        mock: counting,
        injection: {
          fault: "Drop the checkout call and return a timeout instead of executing it.",
          target: "checkout",
          ground_truth: { category: "Execution", code: "dropped_tool_call" },
        },
      }),
    );
    assert.ok(dropped?.trace);
    assert.equal(checkouts, 0);
    assert.equal(dropped.trace.fault.labels.length, 1);
    assert.equal(dropped.trace.fault.labels[0]?.code, "dropped_tool_call");
    assert.equal(
      dropped.trace.steps.filter((step) => step.type === "tool_result" && step.tool_name === "checkout").length,
      3,
    );
    assert.equal(dropped.trace.outcome.verifier.passed, false);
  });
});
