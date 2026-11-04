import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  FAULT_CATEGORIES,
  FIX_KINDS,
  RUN_PHASES,
  RUN_STATUSES,
  TRACE_STATUSES,
  type Trace,
} from "../src/index.js";
import {
  runSchema,
  traceSchema,
  validateAgent,
  validateRun,
  validateTrace,
} from "../src/validate.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readExample(name: string): unknown {
  return JSON.parse(readFileSync(join(root, "examples", name), "utf8")) as unknown;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertOk(result: { ok: boolean; errors?: string[] }, label: string): void {
  assert.equal(result.ok, true, `${label}: ${(result.errors ?? []).join("; ")}`);
}

describe("schema enums match the TypeScript constants", () => {
  it("keeps fault categories and fix kinds aligned across Trace and Run", () => {
    const traceDefs = traceSchema.$defs;
    const runDefs = runSchema.$defs;
    assert.ok(traceDefs);
    assert.ok(runDefs);
    assert.deepEqual(traceDefs.faultCategory?.enum, [...FAULT_CATEGORIES]);
    assert.deepEqual(runDefs.faultCategory?.enum, [...FAULT_CATEGORIES]);
    assert.deepEqual(traceDefs.fixKind?.enum, [...FIX_KINDS]);
    assert.deepEqual(runDefs.fixKind?.enum, [...FIX_KINDS]);
    assert.deepEqual(traceDefs.traceStatus?.enum, [...TRACE_STATUSES]);
    assert.deepEqual(runSchema.properties?.phase?.enum, [...RUN_PHASES]);
    assert.deepEqual(runSchema.properties?.status?.enum, [...RUN_STATUSES]);
  });
});

describe("examples", () => {
  const trace = readExample("injected-failed-trace.json");
  const agent = readExample("agent-reference-stub.json");
  const run = readExample("run-injected.json");

  it("accepts the injected failed trace, including verifier and diagnosis", () => {
    const result = validateTrace(trace);
    assertOk(result, "trace");
    if (!result.ok) return;
    assert.equal(result.value.outcome.success, false);
    assert.equal(result.value.outcome.verifier.passed, false);
    assert.equal(result.value.outcome.agent_claimed_success, true);
    assert.equal(result.value.diagnosis?.category, "Verification");
    assert.equal(result.value.fault.injected, true);
    assert.equal(result.value.fault.labels[0]?.category, "ToolUse");
    const snapshot = result.value.outcome.verifier.mock_state_snapshot;
    assert.ok("carts" in snapshot && "orders" in snapshot && "inventory" in snapshot);
  });

  it("keeps the example trace internally consistent", () => {
    const result = validateTrace(trace);
    assertOk(result, "trace");
    if (!result.ok) return;
    const value = result.value;
    assert.equal(value.outcome.success, value.outcome.verifier.passed);
    const stepIds = new Set(value.steps.map((step) => step.step_id));
    for (const label of value.fault.labels) {
      assert.ok(stepIds.has(label.step_id), `fault label step ${label.step_id}`);
    }
    assert.ok(value.diagnosis);
    assert.ok(stepIds.has(value.diagnosis.step_id));
    assert.deepEqual(
      value.steps.map((step) => step.index),
      value.steps.map((_, index) => index),
    );

    const latency = value.steps.reduce((sum, step) => sum + step.latency_ms, 0);
    const tokensIn = value.steps.reduce((sum, step) => sum + step.token_usage.input, 0);
    const tokensOut = value.steps.reduce((sum, step) => sum + step.token_usage.output, 0);
    const costMicro = value.steps.reduce((sum, step) => sum + Math.round(step.cost_usd * 1_000_000), 0);
    assert.equal(value.totals.latency_ms, latency);
    assert.equal(value.totals.tokens_in, tokensIn);
    assert.equal(value.totals.tokens_out, tokensOut);
    assert.equal(value.totals.cost_usd, costMicro / 1_000_000);

    assert.ok(value.started_at <= value.steps[0]!.timestamp);
    assert.ok(value.steps.at(-1)!.timestamp <= value.ended_at);
  });

  it("accepts the same trace with diagnosis still null", () => {
    const pending = clone(trace) as Trace;
    pending.diagnosis = null;
    assertOk(validateTrace(pending), "null diagnosis");
  });

  it("accepts the reference agent stub with five tasks", () => {
    const result = validateAgent(agent);
    assertOk(result, "agent");
    if (!result.ok) return;
    assert.deepEqual(
      result.value.tasks.map((task) => task.task_id),
      ["T1", "T2", "T3", "T4", "T5"],
    );
    assert.deepEqual(
      result.value.docs.tools.map((tool) => tool.name),
      [
        "search_products",
        "get_product",
        "get_cart",
        "add_to_cart",
        "update_cart",
        "checkout",
        "get_order",
        "cancel_order",
      ],
    );
    for (const task of result.value.tasks) {
      assert.equal(task.success_test.type, "verifier_checks");
    }
  });

  it("accepts the injected run that points at the trace", () => {
    const result = validateRun(run);
    assertOk(result, "run");
    if (!result.ok) return;
    const traceResult = validateTrace(trace);
    assertOk(traceResult, "trace");
    if (!traceResult.ok) return;
    assert.equal(result.value.run_id, traceResult.value.run_id);
    assert.deepEqual(result.value.trace_ids, [traceResult.value.trace_id]);
    assert.equal(result.value.phase, "injected");
    assert.equal(result.value.injection_plan?.ground_truth.code, "forged_tool_result");
    assert.deepEqual(result.value.fix_kinds, []);
  });
});

describe("Run is not a Trace", () => {
  const trace = readExample("injected-failed-trace.json") as Record<string, unknown>;

  it("rejects Run fields copied onto a Trace", () => {
    for (const key of ["phase", "injection_plan", "fix_kinds"]) {
      const invalid = { ...trace, [key]: key === "fix_kinds" ? [] : "baseline" };
      const result = validateTrace(invalid);
      assert.equal(result.ok, false, key);
    }
  });

  it("rejects a baseline run that carries an injection plan or a fix", () => {
    const baseline = {
      run_id: "run-baseline",
      agent_id: "reference-shop",
      task_id: "T1",
      phase: "baseline",
      status: "queued",
      trace_ids: [],
      injection_plan: null,
      fix_kinds: [],
    };
    assertOk(validateRun(baseline), "baseline");

    const withPlan = {
      ...baseline,
      injection_plan: {
        fault: "drop the catalog",
        target: "search_products",
        ground_truth: { category: "Context", code: "dropped_tool_result" },
      },
    };
    assert.equal(validateRun(withPlan).ok, false);

    const withFix = { ...baseline, fix_kinds: ["permission_guard"] };
    assert.equal(validateRun(withFix).ok, false);
  });

  it("requires a fix kind on after_fix and a plan on injected", () => {
    const injected = readExample("run-injected.json") as Record<string, unknown>;
    assert.equal(validateRun({ ...injected, injection_plan: null }).ok, false);
    assert.equal(
      validateRun({ ...injected, fix_kinds: ["controlled_retry"] }).ok,
      false,
    );

    const afterFix = {
      run_id: "run-t3-after-fix",
      agent_id: "reference-shop",
      task_id: "T3",
      parent_run_id: "run-t3-injected-001",
      phase: "after_fix",
      status: "passed",
      trace_ids: ["trace-t3-forged-checkout-replay"],
      injection_plan: injected.injection_plan,
      fix_kinds: ["pre_response_check"],
      duration_ms: 1100,
    };
    assertOk(validateRun(afterFix), "after_fix");
    assert.equal(validateRun({ ...afterFix, fix_kinds: [] }).ok, false);
  });

  it("rejects a clean fault that still carries labels", () => {
    const clean = clone(trace) as unknown as Trace;
    clean.fault = { injected: false, labels: [], attacker: { used: false, payload_id: null } };
    clean.diagnosis = null;
    assertOk(validateTrace(clean), "clean");

    clean.fault.labels = [{ category: "Plan", step_id: "step-0", code: "skipped_step" }];
    assert.equal(validateTrace(clean).ok, false);
  });

  it("requires an attacker payload id only when the attacker was used", () => {
    const attacked = clone(trace) as unknown as Trace;
    attacked.fault.attacker = { used: true, payload_id: null };
    assert.equal(validateTrace(attacked).ok, false);
    attacked.fault.attacker = { used: true, payload_id: "payload-jury-1" };
    assertOk(validateTrace(attacked), "attacker");
    attacked.fault.attacker = { used: false, payload_id: "payload-jury-1" };
    assert.equal(validateTrace(attacked).ok, false);
  });
});
