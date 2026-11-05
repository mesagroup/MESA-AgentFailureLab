import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { LIBRARY_OTEL_SCHEMA_B_ID, type Agent } from "../src/index.js";
import { mapOtelImport } from "../src/otel-import.js";
import { readLibraryOtelMock, remapLibrarySchemaB } from "../src/otel-library-schema-b.js";
import { validateAgent, validateTrace } from "../src/validate.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(root, name), "utf8")) as unknown;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("library schema B mock pull", () => {
  const prodRenew = readJson("examples/otel/library-schema-b/prod-renew-loan.json");
  const prodHold = readJson("examples/otel/library-schema-b/prod-place-hold.json");

  it("maps the prod renew fixture onto a validated trace without inventing a verdict or labels", () => {
    const result = remapLibrarySchemaB(prodRenew, { agentId: "external-library" });
    assert.equal(result.ok, true, result.ok ? "" : result.errors.join("; "));
    if (!result.ok) return;
    assert.equal(result.traces.length, 1);
    const trace = result.traces[0]!;
    assert.equal(validateTrace(trace).ok, true);
    assert.equal(trace.trace_id, "lib-b-prod-renew");
    assert.equal(trace.agent_id, "external-library");
    assert.equal(trace.task_id, "renew-loan");
    assert.equal(trace.status, "completed");
    assert.equal(trace.outcome.success, true);
    assert.equal(trace.outcome.verifier.passed, true);
    assert.equal(trace.fault.injected, false);
    assert.deepEqual(trace.fault.labels, []);
    assert.equal(trace.fault.attacker.used, false);
    assert.equal(trace.diagnosis, null);
    assert.equal(trace.steps[1]?.tool_name, "renew_loan");
    assert.deepEqual(trace.steps[1]?.tool_input, { loan_id: "loan-1042" });
  });

  it("maps the test return fixture through readLibraryOtelMock", () => {
    const agent = readJson("examples/agent-library-desk.json") as Agent;
    assert.equal(agent.otel?.schema_id, LIBRARY_OTEL_SCHEMA_B_ID);
    assert.equal(agent.otel_mock?.schema_id, LIBRARY_OTEL_SCHEMA_B_ID);
    assert.equal(
      agent.otel_mock?.sources.test.fixture_path,
      "packages/shared/examples/otel/library-schema-b/test-return-loan.json",
    );
    const batch = readLibraryOtelMock("test");
    const result = remapLibrarySchemaB(batch, { agentId: "external-library" });
    assert.equal(result.ok, true, result.ok ? "" : result.errors.join("; "));
    if (!result.ok) return;
    assert.equal(result.traces[0]?.task_id, "return-loan");
    assert.equal(result.traces[0]?.steps.some((step) => step.tool_name === "return_loan"), true);
    assert.equal(validateTrace(result.traces[0]).ok, true);
  });

  it("maps the prod hold export", () => {
    const result = remapLibrarySchemaB(prodHold, { agentId: "external-library" });
    assert.equal(result.ok, true, result.ok ? "" : result.errors.join("; "));
    if (!result.ok) return;
    assert.equal(result.traces[0]?.task_id, "place-hold");
    assert.equal(result.traces[0]?.steps.some((step) => step.tool_name === "place_hold"), true);
    assert.equal(validateTrace(result.traces[0]).ok, true);
  });

  it("rejects schema A with an explicit schema_hint error", () => {
    const wrong = clone(prodRenew) as { schema_hint: string };
    wrong.schema_hint = "mesa.otel.shop.a";
    const result = remapLibrarySchemaB(wrong, { agentId: "external-library" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errors.join(" "), "schema_hint mesa.otel.shop.a is not mesa.otel.library.b");
  });

  it("is rejected by the generic mapper", () => {
    const result = mapOtelImport(prodRenew, { agentId: "external-library" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.length > 0);
  });

  it("rejects a missing verdict", () => {
    const missing = clone(prodRenew) as { library_export: { verdict?: unknown } };
    delete missing.library_export.verdict;
    const result = remapLibrarySchemaB(missing, { agentId: "external-library" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.errors.join(" "), /verdict|library_export/);
  });

  it("rejects a lib.fault.labels attribute", () => {
    const poisoned = clone(prodRenew) as {
      spans: Array<{ lib_attrs: Record<string, unknown> }>;
    };
    poisoned.spans[0]!.lib_attrs["lib.fault.labels"] = [{ category: "ToolUse" }];
    const result = remapLibrarySchemaB(poisoned, { agentId: "external-library" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.length > 0);
  });

  it("accepts the library seed with dual otel and otel_mock fixture mode", () => {
    const library = readJson("examples/agent-library-desk.json") as Agent;
    const shop = readJson("examples/agent-reference-shop.json") as Agent;
    const libraryResult = validateAgent(library);
    const shopResult = validateAgent(shop);
    assert.equal(libraryResult.ok, true, libraryResult.ok ? "" : libraryResult.errors.join("; "));
    assert.equal(shopResult.ok, true, shopResult.ok ? "" : shopResult.errors.join("; "));
    assert.equal(shop.otel?.schema_id, "mesa.otel.shop.a");
    assert.equal(shop.otel_mock?.schema_id, "mesa.otel.shop.a");
    assert.equal(library.otel?.schema_id, LIBRARY_OTEL_SCHEMA_B_ID);
    assert.match(library.otel?.prod.endpoint ?? "", /\/internal\/otel\/traces\?source=prod$/);
    assert.match(library.otel?.test.endpoint ?? "", /\/internal\/otel\/traces\?source=test$/);
    assert.equal(library.otel_mock?.mode, "fixture");
    assert.equal(library.otel_mock?.schema_id, LIBRARY_OTEL_SCHEMA_B_ID);
  });
});
