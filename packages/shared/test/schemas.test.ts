import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CHECK_TYPES,
  FAULT_CATEGORIES,
  FIX_KINDS,
  RUN_PHASES,
  RUN_STATUSES,
  TASK_EVALSET_VERSION,
  TASK_PERMISSIONS,
  TRACE_SOURCES,
  TRACE_STATUSES,
  type Agent,
  type TaskEvalset,
  type Trace,
} from "../src/index.js";
import {
  runSchema,
  traceSchema,
  validateAgent,
  validateRun,
  validateTaskEvalset,
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
    assert.deepEqual(traceSchema.properties?.source?.enum, [...TRACE_SOURCES]);
    assert.deepEqual(runSchema.properties?.phase?.enum, [...RUN_PHASES]);
    assert.deepEqual(runSchema.properties?.status?.enum, [...RUN_STATUSES]);
  });
});

describe("examples", () => {
  const trace = readExample("injected-failed-trace.json");
  const agent = readExample("agent-reference-shop.json");
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

  it("accepts an optional trace source and rejects a value outside the enum", () => {
    const omitted = validateTrace(trace);
    assertOk(omitted, "trace without source");
    if (!omitted.ok) return;
    assert.equal(omitted.value.source, undefined);
    const tagged = validateTrace({ ...omitted.value, source: "otel_prod" });
    assertOk(tagged, "otel_prod");
    if (!tagged.ok) return;
    assert.equal(tagged.value.source, "otel_prod");
    const rejected = validateTrace({ ...omitted.value, source: "prod" });
    assert.equal(rejected.ok, false);
  });

  it("accepts the shared diagnosis fixtures with diagnosis still null", () => {
    for (const name of ["timeout-repeated-tool-trace.json", "tool-error-trace.json"]) {
      const result = validateTrace(readExample(name));
      assertOk(result, name);
      if (!result.ok) {
        continue;
      }
      assert.equal(result.value.diagnosis, null);
      assert.equal(result.value.fault.injected, false);
      assert.equal(result.value.fault.labels.length, 0);
    }
  });

  it("accepts the same trace with diagnosis still null", () => {
    const pending = clone(trace) as Trace;
    pending.diagnosis = null;
    assertOk(validateTrace(pending), "null diagnosis");
  });

  it("accepts the reference shop agent with five tasks", () => {
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
      assert.ok(Array.isArray(task.setup.cart));
      assert.ok(Array.isArray(task.setup.orders));
      assert.ok(task.setup.permissions.length > 0);
    }
    const checkout = result.value.tasks.find((task) => task.task_id === "T3");
    assert.deepEqual(checkout?.setup.cart, [{ sku: "SKU-MUG-01", qty: 2 }]);
    assert.deepEqual(checkout?.setup.orders, []);
    const cancel = result.value.tasks.find((task) => task.task_id === "T5");
    assert.deepEqual(cancel?.setup.orders, [{ from_cart: true }]);
    assert.deepEqual(cancel?.setup.permissions, ["read", "write:order:cancel"]);
  });

  it("accepts the T1 evalset and tasks that omit it", () => {
    const result = validateAgent(agent);
    assertOk(result, "agent");
    if (!result.ok) return;
    const t1 = result.value.tasks.find((task) => task.task_id === "T1");
    const expected: TaskEvalset = {
      version: TASK_EVALSET_VERSION,
      cases: [
        {
          case_id: "claim-after-catalog",
          expectation: "The assistant claims it opened the ceramic mug only after a catalog search and a product read.",
          rubric: "Cite the claim step and the tool steps. Do not score cart or order state; that is outcome.verifier.",
        },
      ],
    };
    assert.deepEqual(t1?.evalset, expected);
    for (const taskId of ["T2", "T3", "T4", "T5"]) {
      assert.equal(result.value.tasks.find((task) => task.task_id === taskId)?.evalset, undefined, taskId);
    }

    const library = validateAgent(readExample("agent-library-desk.json"));
    assertOk(library, "library");
    if (!library.ok) return;
    assert.ok(library.value.tasks.every((task) => task.evalset === undefined));

    const emptied = clone(agent) as Agent;
    emptied.tasks[0]!.evalset = { version: TASK_EVALSET_VERSION, cases: [] };
    assertOk(validateAgent(emptied), "empty cases");

    const withoutRubric = clone(agent) as Agent;
    delete withoutRubric.tasks[0]!.evalset!.cases[0]!.rubric;
    assertOk(validateAgent(withoutRubric), "rubric omitted");

    const stripped = clone(agent) as Agent;
    for (const task of stripped.tasks) delete task.evalset;
    assertOk(validateAgent(stripped), "evalset omitted");
  });

  it("rejects an evalset that is not version 1 judge input", () => {
    const wrongVersion = clone(agent) as Agent;
    wrongVersion.tasks[0]!.evalset = { version: 2, cases: [] } as unknown as TaskEvalset;
    assert.equal(validateAgent(wrongVersion).ok, false);

    const missingExpectation = clone(agent) as Agent;
    missingExpectation.tasks[0]!.evalset = {
      version: TASK_EVALSET_VERSION,
      cases: [{ case_id: "bare", expectation: "" }],
    };
    assert.equal(validateAgent(missingExpectation).ok, false);

    const extra = clone(agent) as Agent;
    (extra.tasks[0]!.evalset as unknown as Record<string, unknown>).outcome = { verifier: { passed: true } };
    const extraResult = validateAgent(extra);
    assert.equal(extraResult.ok, false);
    if (!extraResult.ok) assert.match(extraResult.errors.join(" "), /additional/);

    const duplicate = clone(agent) as Agent;
    duplicate.tasks[0]!.evalset = {
      version: TASK_EVALSET_VERSION,
      cases: [
        { case_id: "same", expectation: "First reading of the claim." },
        { case_id: "same", expectation: "Second reading of the claim." },
      ],
    };
    const duplicated = validateAgent(duplicate);
    assert.equal(duplicated.ok, false);
    if (!duplicated.ok) assert.match(duplicated.errors.join(" "), /duplicate case_id same/);

    const asNull = clone(agent) as unknown as Record<string, unknown>;
    (asNull.tasks as Array<Record<string, unknown>>)[0]!.evalset = null;
    assert.equal(validateAgent(asNull).ok, false);
  });

  it("rejects an unknown check, invalid params, and a duplicate task id", () => {
    const unknown = clone(agent) as Agent;
    unknown.tasks[0]!.success_test.checks[0]!.name = "task_complete";
    assert.equal(validateAgent(unknown).ok, false);

    const missingQty = clone(agent) as Agent;
    missingQty.tasks[1]!.success_test.checks[0]!.params = { sku: "SKU-MUG-01" };
    const missing = validateAgent(missingQty);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.errors.join(" "), /qty/);

    const extra = clone(agent) as Agent;
    extra.tasks[1]!.success_test.checks[0]!.params = { sku: "SKU-MUG-01", qty: 2, note: "no" };
    const extraResult = validateAgent(extra);
    assert.equal(extraResult.ok, false);
    if (!extraResult.ok) assert.match(extraResult.errors.join(" "), /note/);

    const duplicate = clone(agent) as Agent;
    duplicate.tasks[1]!.task_id = "T1";
    const duplicated = validateAgent(duplicate);
    assert.equal(duplicated.ok, false);
    if (!duplicated.ok) assert.match(duplicated.errors.join(" "), /duplicate task_id T1/);
  });

  it("keeps the check registry and the agent schema on the same names", () => {
    const schema = JSON.parse(readFileSync(join(root, "schemas", "agent.schema.json"), "utf8")) as {
      $defs: {
        task: {
          properties: {
            setup: { properties: { permissions: { items: { enum: string[] } } } };
            success_test: { properties: { checks: { items: { properties: { name: { enum: string[] } } } } } };
          };
        };
      };
    };
    assert.deepEqual(schema.$defs.task.properties.success_test.properties.checks.items.properties.name.enum, [
      ...CHECK_TYPES,
    ]);
    assert.deepEqual(schema.$defs.task.properties.setup.properties.permissions.items.enum, [...TASK_PERMISSIONS]);
  });

  it("keeps evalset version 1 aligned with TASK_EVALSET_VERSION", () => {
    const schema = JSON.parse(readFileSync(join(root, "schemas", "agent.schema.json"), "utf8")) as {
      $defs: {
        task: {
          properties: {
            evalset: {
              required: string[];
              properties: {
                version: { const: number };
                cases: { items: { required: string[]; properties: { rubric: { minLength: number } } } };
              };
            };
          };
        };
      };
    };
    const evalset = schema.$defs.task.properties.evalset;
    assert.equal(evalset.properties.version.const, TASK_EVALSET_VERSION);
    assert.deepEqual(evalset.required, ["version", "cases"]);
    assert.deepEqual(evalset.properties.cases.items.required, ["case_id", "expectation"]);
    assert.equal(evalset.properties.cases.items.required.includes("rubric"), false);
    assert.equal(evalset.properties.cases.items.properties.rubric.minLength, 1);
  });

  it("validates a standalone evalset with the same rules as on a task", () => {
    const result = validateAgent(agent);
    assertOk(result, "agent");
    if (!result.ok) return;
    const t1 = result.value.tasks[0]!.evalset;
    assert.ok(t1);
    assertOk(validateTaskEvalset(t1), "t1 evalset");
    const ok = validateTaskEvalset({
      version: TASK_EVALSET_VERSION,
      cases: [{ case_id: "claim", expectation: "Cite the catalog read." }],
    });
    assertOk(ok, "evalset");
    const empty = validateTaskEvalset({ version: TASK_EVALSET_VERSION, cases: [] });
    assertOk(empty, "empty evalset");
    assert.equal(validateTaskEvalset({ version: 2, cases: [] }).ok, false);
    const duplicate = validateTaskEvalset({
      version: TASK_EVALSET_VERSION,
      cases: [
        { case_id: "same", expectation: "First." },
        { case_id: "same", expectation: "Second." },
      ],
    });
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) assert.match(duplicate.errors.join(" "), /duplicate case_id same/);
    const extra = validateTaskEvalset({
      version: TASK_EVALSET_VERSION,
      cases: [],
      outcome: { verifier: { passed: true } },
    });
    assert.equal(extra.ok, false);
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

  it("rejects an evalset copied onto a Trace", () => {
    const invalid = { ...trace, evalset: { version: TASK_EVALSET_VERSION, cases: [] } };
    assert.equal(validateTrace(invalid).ok, false);
  });

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
