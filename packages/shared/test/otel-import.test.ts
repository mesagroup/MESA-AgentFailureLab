import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { OTEL_IMPORT_VERSION, OTEL_SOURCE_VERSION, type Agent } from "../src/index.js";
import { mapOtelImport } from "../src/otel-import.js";
import { validateAgent, validateTrace } from "../src/validate.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(root, name), "utf8")) as unknown;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("OTel import", () => {
  const batch = readJson("examples/otel/t1-search.import.json");
  const source = readJson("examples/otel/source.json");

  it("maps the fixture onto a validated trace without inventing a verdict or labels", () => {
    const result = mapOtelImport(batch, { agentId: "reference-shop", serviceName: "reference-shop" });
    assert.equal(result.ok, true, result.ok ? "" : result.errors.join("; "));
    if (!result.ok) return;
    assert.equal(result.traces.length, 1);
    const trace = result.traces[0]!;
    assert.equal(validateTrace(trace).ok, true);
    assert.equal(trace.trace_id, "otel-t1-search");
    assert.equal(trace.agent_id, "reference-shop");
    assert.equal(trace.run_id, "run-otel-t1-search");
    assert.equal(trace.task_id, "T1");
    assert.equal(trace.status, "completed");
    assert.equal(trace.diagnosis, null);
    assert.deepEqual(trace.fault, { injected: false, labels: [], attacker: { used: false, payload_id: null } });
    assert.equal(trace.outcome.verifier.passed, true);
    assert.equal(trace.outcome.success, true);
    assert.equal(trace.outcome.verifier.checks[0]?.detail, "Supplied with the import. Not computed from spans.");
    assert.deepEqual(
      trace.steps.map((step) => step.type),
      ["message", "tool_call", "tool_result", "tool_call", "tool_result", "message"],
    );
    assert.equal(trace.steps[1]?.tool_name, "search_products");
    assert.deepEqual(trace.steps[1]?.tool_input, { q: "mug" });
    assert.deepEqual(trace.steps[3]?.tool_input, { product_id: "SKU-MUG-01" });
    assert.equal(trace.steps[5]?.token_usage.input, 30);
    assert.equal(trace.steps[5]?.token_usage.output, 8);
    assert.equal(trace.steps[2]?.token_usage.input, 0);
    assert.equal(trace.steps[2]?.cost_usd, 0);
    assert.equal(trace.totals.tokens_in, 80);
    assert.equal(trace.totals.tokens_out, 16);
    assert.equal(trace.totals.cost_usd, 0.00008);
    assert.equal(trace.totals.latency_ms, 14 + 612 + 37 + 544 + 29 + 703);
    assert.equal(result.runs[0]?.phase, "baseline");
    assert.equal(result.runs[0]?.injection_plan, null);
    assert.deepEqual(result.runs[0]?.fix_kinds, []);
    assert.equal(result.runs[0]?.status, "passed");
    assert.deepEqual(result.runs[0]?.trace_ids, ["otel-t1-search"]);
  });

  it("accepts the source document on an agent and still accepts agents that omit it", () => {
    const shop = readJson("examples/agent-reference-shop.json") as Agent;
    assert.equal(shop.otel?.schema_id, "mesa.otel.shop.a");
    assert.equal(validateAgent(shop).ok, true);
    const library = readJson("examples/agent-library-desk.json") as Agent;
    assert.equal(library.otel?.schema_id, "mesa.otel.library.b");
    assert.equal(validateAgent(library).ok, true);
    const omitted = clone(library);
    delete omitted.otel;
    delete omitted.otel_mock;
    assert.equal(validateAgent(omitted).ok, true);
    const withSource = clone(omitted);
    withSource.otel = source as Agent["otel"];
    const saved = validateAgent(withSource);
    assert.equal(saved.ok, true, saved.ok ? "" : saved.errors.join("; "));
    if (!saved.ok) return;
    assert.equal(saved.value.otel?.version, OTEL_SOURCE_VERSION);
    assert.equal(saved.value.otel?.prod.auth.token_env, "OTEL_SOURCE_TOKEN");

    const bearerWithoutEnv = clone(withSource);
    delete bearerWithoutEnv.otel!.prod.auth.token_env;
    assert.equal(validateAgent(bearerWithoutEnv).ok, false);

    const noneWithEnv = clone(withSource);
    noneWithEnv.otel!.prod.auth = { type: "none", token_env: "OTEL_SOURCE_TOKEN" };
    assert.equal(validateAgent(noneWithEnv).ok, false);

    const tokenInTheField = clone(withSource);
    tokenInTheField.otel!.prod.auth.token_env = "secret-token-value";
    assert.equal(validateAgent(tokenInTheField).ok, false);
  });

  it("rejects a missing verdict, a span verdict, and a mismatched status", () => {
    const missing = clone(batch) as { items: Array<Record<string, unknown>> };
    delete missing.items[0]!.outcome;
    const missingResult = mapOtelImport(missing, { agentId: "reference-shop" });
    assert.equal(missingResult.ok, false);
    if (!missingResult.ok) assert.match(missingResult.errors.join(" "), /outcome/);

    const labeled = clone(batch) as {
      items: Array<{ spans: Array<{ attributes: Record<string, unknown> }> }>;
    };
    labeled.items[0]!.spans[0]!.attributes["mesa.fault.labels"] = [{ category: "Plan", step_id: "span-user", code: "skipped_step" }];
    const labeledResult = mapOtelImport(labeled, { agentId: "reference-shop" });
    assert.equal(labeledResult.ok, false);
    if (!labeledResult.ok) assert.match(labeledResult.errors.join(" "), /does not read fault labels/);

    const flipped = clone(batch) as { items: Array<{ outcome: { success: boolean; verifier: { passed: boolean } } }> };
    flipped.items[0]!.outcome.success = false;
    const flippedResult = mapOtelImport(flipped, { agentId: "reference-shop" });
    assert.equal(flippedResult.ok, false);
    if (!flippedResult.ok) assert.match(flippedResult.errors.join(" "), /does not rewrite/);

    const completedDespiteFailure = clone(batch) as {
      items: Array<{ status?: string; outcome: { success: boolean; verifier: { passed: boolean } } }>;
    };
    completedDespiteFailure.items[0]!.outcome.success = false;
    completedDespiteFailure.items[0]!.outcome.verifier.passed = false;
    completedDespiteFailure.items[0]!.status = "completed";
    const statusResult = mapOtelImport(completedDespiteFailure, { agentId: "reference-shop" });
    assert.equal(statusResult.ok, false);
    if (!statusResult.ok) assert.match(statusResult.errors.join(" "), /Span status is not a verdict/);

    assert.equal(OTEL_IMPORT_VERSION, 1);
  });

  it("rejects a service name that does not match the agent source", () => {
    const result = mapOtelImport(batch, { agentId: "reference-shop", serviceName: "other-service" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.errors.join(" "), /service_name/);
  });
});
