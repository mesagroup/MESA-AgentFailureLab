import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { FIX_KINDS, type Agent, type AgentRunRequest, type FixKind, type InjectionPlan, type RunPhase, type Trace } from "@mesa/shared";
import { validateAgent, validateRun, validateTrace } from "@mesa/shared/validate";
import { buildApp as buildHarness } from "../../backend/src/app.js";
import { MemoryAgentStore } from "../../backend/src/agents/store.js";
import type { TaskRunResult } from "../../backend/src/harness/runner.js";
import { normalizePlan } from "../../backend/src/injector/catalog.js";
import { parseSnapshot } from "../../backend/src/mock/snapshot.js";
import { MemoryStore } from "../../backend/src/persistence/memory.js";
import { buildApp as buildShop } from "../../../services/mock-shop/src/app.js";
import { buildApp as buildAgentService } from "../src/app.js";
import type { DiagnosisModel } from "../src/diagnosis/diagnose.js";
import type { TaskRunPlan } from "../src/reference-agent/plan.js";

interface Scenario {
  schema_version: number;
  scenario_id: string;
  agent_file: string;
  task_id: string;
  driver: "http";
  planner_endpoint: string;
  same_endpoint_for_all_phases: boolean;
  dedicated_mock_required: boolean;
  serial_execution_required: boolean;
  injection_plan: InjectionPlan;
  clean_control_task_ids: string[];
  test_expectations: {
    reference_fix: FixKind;
    irrelevant_fix: FixKind;
    fix_source: string;
    failed_check_before: string;
    arms: Array<{
      name: string;
      phase: RunPhase;
      injection: "none" | "scenario";
      fix: "none" | "reference" | "irrelevant";
      verifier_passed: boolean;
    }>;
    regression_probe: { task_id: string; role: string; injection_plan: InjectionPlan; failed_check: string };
  };
}

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../scenarios/shop-readback-v1/${name}`, import.meta.url), "utf8"));
}

const scenario = fixture("scenario.json") as Scenario;

function fixtureAgent(): Agent {
  const parsed = validateAgent(fixture(scenario.agent_file));
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.value;
}

function planIdentity(plan: InjectionPlan | null) {
  if (plan === null) return null;
  const { step_id: _generated, ...groundTruth } = plan.ground_truth;
  return { ...plan, ground_truth: groundTruth };
}

type Attempt = TaskRunResult & { trace: Trace };

/** Test-only setup. Real HTTP on every hop; no callAgent/toolHook override. */
async function experiment(input: { agent?: Agent; model?: DiagnosisModel | null } = {}) {
  const shop = buildShop({ logger: false });
  const requests: AgentRunRequest[] = [];
  const plans: TaskRunPlan[] = [];
  const shopCalls: Array<{ path: string; session: string | undefined }> = [];
  const modelViews: Record<string, unknown>[] = [];
  const service = buildAgentService({ logger: false,
    config: { apiKey: null, baseUrl: "http://unused.invalid", modelName: "offline-contract-model", timeoutMs: 1000 },
    model: input.model === undefined ? {
      complete: async request => {
        const view = JSON.parse(request.user) as Record<string, unknown> & { steps: Trace["steps"] };
        modelViews.push(view);
        assert.equal(view.fault, undefined);
        assert.equal(view.outcome, undefined);
        assert.equal(view.run_id, undefined);
        assert.doesNotMatch(request.user, /suppressed_readback|ground_truth|mock_state_snapshot/);
        const closing = [...view.steps].reverse().find(step => step.role === "assistant" && step.type === "message");
        assert.ok(closing);
        // Explicit offline fixture, not a measured Grok diagnosis or a live fallback.
        return { content: JSON.stringify({
          category: "Verification", cause: "The attempt claimed success without a confirming product read.",
          step_id: closing.step_id, confidence: 0.8,
          evidence: [`${closing.step_id} claims completion without a product result`],
          proposed_fixes: ["pre_response_check"],
        }), usage: null };
      },
    } : input.model,
  });
  service.addHook("preHandler", async request => {
    if (request.url === scenario.planner_endpoint) requests.push(structuredClone(request.body as AgentRunRequest));
  });
  service.addHook("onSend", async (request, _reply, payload) => {
    if (request.url === scenario.planner_endpoint) plans.push(JSON.parse(String(payload)) as TaskRunPlan);
    return payload;
  });
  shop.addHook("onRequest", async request => {
    shopCalls.push({ path: request.url, session: request.headers["x-session-id"] as string | undefined });
  });
  const store = new MemoryStore();
  const agents = new MemoryAgentStore();
  let harness: ReturnType<typeof buildHarness> | undefined;
  try {
    const mockBaseUrl = await shop.listen({ host: "127.0.0.1", port: 0 });
    const agentBaseUrl = await service.listen({ host: "127.0.0.1", port: 0 });
    const agent = input.agent ?? fixtureAgent();
    agent.instance.base_url = agentBaseUrl;
    agent.test_instance.base_url = agentBaseUrl;
    harness = buildHarness({ logger: false, agent, agents, store, mockBaseUrl, diagnosis: { baseUrl: agentBaseUrl } });
    const backendUrl = await harness.listen({ host: "127.0.0.1", port: 0 });
    const registered = await fetch(`${backendUrl}/agents`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(agent),
    });
    assert.equal(registered.status, 201);
    assert.deepEqual(await registered.json(), agent);

    async function run(input: { taskId?: string; phase: RunPhase; injection: InjectionPlan | null; fixes?: FixKind[]; parent?: string }): Promise<Attempt> {
      const response = await fetch(`${backendUrl}/runs`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent_id: agent.agent_id, task_ids: [input.taskId ?? scenario.task_id],
          phase: input.phase, driver: scenario.driver, injection: input.injection,
          ...(input.fixes?.length ? { fix_kinds: input.fixes } : {}),
          ...(input.parent ? { parent_run_id: input.parent } : {}), timeout_ms: 5000 }),
      });
      const body = await response.json() as { results: TaskRunResult[] };
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.results.length, 1);
      const result = body.results[0];
      const trace = result.trace;
      assert.ok(trace, result.run.error_message);
      assert.equal(validateRun(result.run).ok, true);
      assert.equal(validateTrace(trace).ok, true);
      assert.equal(result.driver, "http");
      assert.equal(result.run.agent_id, agent.agent_id);
      assert.equal(trace.outcome.success, trace.outcome.verifier.passed);
      assert.deepEqual(trace, await store.getTrace(trace.trace_id));
      return { ...result, trace };
    }

    return { agent, backendUrl, requests, plans, shopCalls, store, modelViews, run,
      close: async () => { await harness?.close(); await service.close(); await shop.close(); } };
  } catch (error) {
    await Promise.allSettled([harness?.close(), service.close(), shop.close()]);
    throw error;
  }
}

describe("canonical shop readback scenario v1 (offline, isolated HTTP)", { concurrency: false }, () => {
  it("ships a standalone Agent and a complete, explicit intervention matrix", () => {
    const agent = fixtureAgent();
    assert.equal(scenario.schema_version, 1);
    assert.equal(scenario.driver, "http");
    assert.equal(scenario.planner_endpoint, "/v1/tasks/run");
    assert.equal(scenario.same_endpoint_for_all_phases, true);
    assert.equal(scenario.dedicated_mock_required, true);
    assert.equal(scenario.serial_execution_required, true);
    assert.notEqual(agent.agent_id, "reference-shop");
    assert.equal(agent.instance.base_url, agent.test_instance.base_url);
    assert.equal(agent.tasks.some(task => /^T[1-5]$/.test(task.task_id)), false);
    assert.deepEqual(scenario.clean_control_task_ids, agent.tasks.map(task => task.task_id));
    assert.deepEqual(normalizePlan(scenario.injection_plan), scenario.injection_plan);
    assert.deepEqual(normalizePlan(scenario.test_expectations.regression_probe.injection_plan), scenario.test_expectations.regression_probe.injection_plan);
    assert.ok(FIX_KINDS.includes(scenario.test_expectations.reference_fix));
    assert.ok(FIX_KINDS.includes(scenario.test_expectations.irrelevant_fix));
    assert.match(scenario.test_expectations.fix_source, /contract-test.*live orchestration/);
    assert.equal(scenario.test_expectations.arms.length, 6);
  });

  it("proves the six-arm matrix against actual calls, snapshots and the backend verifier", async context => {
    const lab = await experiment();
    try {
      const attempts = new Map<string, Attempt>();
      for (const arm of scenario.test_expectations.arms) {
        const fixes = arm.fix === "none" ? [] : [arm.fix === "reference" ? scenario.test_expectations.reference_fix : scenario.test_expectations.irrelevant_fix];
        const parent = arm.phase === "after_fix" ? attempts.get(arm.injection === "none" ? "baseline" : "injected")?.run.run_id : undefined;
        const result = await lab.run({ phase: arm.phase, injection: arm.injection === "none" ? null : scenario.injection_plan, fixes, parent });
        attempts.set(arm.name, result);
        assert.equal(result.trace.outcome.verifier.passed, arm.verifier_passed, arm.name);
        assert.deepEqual(result.permissions, lab.agent.tasks[0].setup.permissions);
        assert.deepEqual(result.run.fix_kinds, fixes);
        assert.equal(result.run.parent_run_id ?? undefined, parent);
        assert.deepEqual(planIdentity(result.run.injection_plan), arm.injection === "none" ? null : scenario.injection_plan);
        assert.equal(result.trace.fault.injected, arm.injection !== "none");
        assert.equal(result.trace.fault.labels.length, arm.injection === "none" ? 0 : 1);
        if (arm.injection === "scenario") {
          const label = result.trace.fault.labels[0];
          assert.equal(label.category, scenario.injection_plan.ground_truth.category);
          assert.equal(label.code, scenario.injection_plan.ground_truth.code);
          assert.ok(result.trace.steps.some(step => step.step_id === label.step_id));
        }
      }
      const before = attempts.get("injected")!, after = attempts.get("after_fix")!;
      assert.equal(before.trace.outcome.agent_claimed_success, true);
      assert.equal(before.trace.outcome.verifier.checks.find(check => check.name === scenario.test_expectations.failed_check_before)?.passed, false);
      const views = (attempt: Attempt) => parseSnapshot(attempt.trace.outcome.verifier.mock_state_snapshot)
        .observations.find(observation => observation.session_id === attempt.session_id)?.product_views ?? [];
      assert.equal(views(before).length, 0);
      assert.deepEqual(views(after).map(view => view.product_id), ["SKU-MUG-01"]);
      assert.equal(lab.shopCalls.filter(call => call.session === before.session_id && call.path === "/products/SKU-MUG-01").length, 0);
      assert.equal(lab.shopCalls.filter(call => call.session === after.session_id && call.path === "/products/SKU-MUG-01").length, 1);
      assert.deepEqual(lab.plans[1].actions.map(action => action.tool_name), ["search_products", "get_product"]);
      assert.deepEqual(lab.plans[2].actions.slice(0, 2), lab.plans[1].actions);
      assert.deepEqual(lab.plans[2].actions.map(action => action.tool_name), ["search_products", "get_product", "get_product"]);
      assert.equal(lab.requests.length, scenario.test_expectations.arms.length);
      lab.requests.forEach((request, index) => {
        assert.equal(request.agent_id, lab.agent.agent_id);
        assert.deepEqual(request.task, lab.agent.tasks[0]);
        assert.deepEqual(request.permissions, lab.agent.tasks[0].setup.permissions);
        const arm = scenario.test_expectations.arms[index];
        const expectedFixes = arm.fix === "none" ? undefined : [arm.fix === "reference" ? scenario.test_expectations.reference_fix : scenario.test_expectations.irrelevant_fix];
        assert.deepEqual(request.fix_kinds, expectedFixes);
        assert.equal(lab.plans[index].executed, false);
      });
      assert.equal(lab.modelViews.length, 0); // Intervention matrix is not an automatic Grok choice.
      context.diagnostic(JSON.stringify({ scenario: scenario.scenario_id, mode: "offline-contract-test",
        rows: [...attempts].map(([arm, attempt]) => ({ arm, verifier_passed: attempt.trace.outcome.verifier.passed,
          agent_claimed_success: attempt.trace.outcome.agent_claimed_success,
          failed_checks: attempt.trace.outcome.verifier.checks.filter(check => !check.passed).map(check => check.name) })) }));
    } finally { await lab.close(); }
  });

  it("keeps all five clean controls passing and exposes a synthetic regression in the evidence matrix", async context => {
    const lab = await experiment();
    try {
      const controls: Array<{ task_id: string; baseline: boolean; treated: boolean; failed_checks: string[] }> = [];
      for (const taskId of scenario.clean_control_task_ids) {
        const baseline = await lab.run({ taskId, phase: "baseline", injection: null });
        const treated = await lab.run({ taskId, phase: "after_fix", injection: null,
          fixes: [scenario.test_expectations.reference_fix], parent: baseline.run.run_id });
        assert.equal(baseline.trace.outcome.verifier.passed, true, taskId);
        assert.equal(treated.trace.outcome.verifier.passed, true, taskId);
        assert.equal(treated.run.injection_plan, null);
        assert.deepEqual(treated.run.fix_kinds, [scenario.test_expectations.reference_fix]);
        controls.push({ task_id: taskId, baseline: baseline.trace.outcome.verifier.passed,
          treated: treated.trace.outcome.verifier.passed,
          failed_checks: treated.trace.outcome.verifier.checks.filter(check => !check.passed).map(check => check.name) });
      }
      const probe = scenario.test_expectations.regression_probe;
      const corrupted = await lab.run({ taskId: probe.task_id, phase: "after_fix", injection: probe.injection_plan,
        fixes: [scenario.test_expectations.reference_fix] });
      assert.equal(corrupted.trace.outcome.verifier.passed, false);
      assert.equal(corrupted.trace.outcome.verifier.checks.find(check => check.name === probe.failed_check)?.passed, false);
      const clean = controls.find(control => control.task_id === probe.task_id)!;
      assert.equal(clean.baseline && !corrupted.trace.outcome.verifier.passed, true);
      assert.equal(parseSnapshot(corrupted.trace.outcome.verifier.mock_state_snapshot).carts[0]?.items[0]?.qty, 1);
      context.diagnostic(JSON.stringify({ scenario: scenario.scenario_id, mode: "offline-contract-test", clean_controls: controls,
        synthetic_probe: { role: probe.role, task_id: probe.task_id, verifier_passed: corrupted.trace.outcome.verifier.passed,
          failed_checks: corrupted.trace.outcome.verifier.checks.filter(check => !check.passed).map(check => check.name) } }));
    } finally { await lab.close(); }
  });

  it("can diagnose through #98 and replay only the explicitly offline model's proposed fixes", async () => {
    const lab = await experiment();
    try {
      const before = await lab.run({ phase: "injected", injection: scenario.injection_plan });
      const response = await fetch(`${lab.backendUrl}/traces/${before.trace.trace_id}/diagnose`, { method: "POST" });
      assert.equal(response.status, 200);
      const diagnosed = await response.json() as Trace;
      assert.ok(diagnosed.diagnosis);
      assert.equal(lab.modelViews.length, 1);
      assert.deepEqual(diagnosed.outcome, before.trace.outcome);
      assert.deepEqual(diagnosed, await lab.store.getTrace(before.trace.trace_id));
      const after = await lab.run({ phase: "after_fix", injection: scenario.injection_plan,
        fixes: diagnosed.diagnosis.proposed_fixes, parent: before.run.run_id });
      assert.equal(after.trace.outcome.verifier.passed, true);
      assert.deepEqual(after.run.fix_kinds, diagnosed.diagnosis.proposed_fixes);
    } finally { await lab.close(); }
  });

  it("supports new product/task data without relying on T1 or the default mug readback", async () => {
    const agent = fixtureAgent();
    agent.agent_id = "notebook-contract-test";
    agent.tasks = [agent.tasks[0]];
    const task = agent.tasks[0];
    task.task_id = "read-notebook";
    task.prompt = "Search for a notebook and open its product page.";
    task.success_test.checks[0].params = { query: "notebook" };
    task.success_test.checks[1].params = { product_id: "SKU-NOTE-05" };
    const lab = await experiment({ agent });
    try {
      const baseline = await lab.run({ taskId: task.task_id, phase: "baseline", injection: null });
      const before = await lab.run({ taskId: task.task_id, phase: "injected", injection: scenario.injection_plan });
      const after = await lab.run({ taskId: task.task_id, phase: "after_fix", injection: scenario.injection_plan,
        fixes: [scenario.test_expectations.reference_fix], parent: before.run.run_id });
      assert.deepEqual([baseline, before, after].map(result => result.trace.outcome.verifier.passed), [true, false, true]);
      const read = after.trace.steps.find(step => step.type === "tool_call" && step.tool_name === "get_product");
      assert.deepEqual(read?.tool_input, { product_id: "SKU-NOTE-05" });
    } finally { await lab.close(); }
  });

  it("does not turn an unavailable live diagnosis into the expected contract fix", async () => {
    const lab = await experiment({ model: null });
    try {
      const before = await lab.run({ phase: "injected", injection: scenario.injection_plan });
      const response = await fetch(`${lab.backendUrl}/traces/${before.trace.trace_id}/diagnose`, { method: "POST" });
      assert.equal(response.status, 503);
      assert.equal((await lab.store.getTrace(before.trace.trace_id))?.diagnosis, null);
      assert.equal(lab.requests.length, 1); // No replay and no category/ground-truth fallback.
    } finally { await lab.close(); }
  });
});
