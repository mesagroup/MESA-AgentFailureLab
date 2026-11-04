import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const schemaDir = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");

function load(name: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(schemaDir, name), "utf8"));
  assert.equal(typeof parsed, "object");
  assert.notEqual(parsed, null);
  return parsed as Record<string, unknown>;
}

function stringList(value: unknown): string[] {
  assert.ok(Array.isArray(value));
  for (const entry of value) {
    assert.equal(typeof entry, "string");
  }
  return value as string[];
}

function objectProps(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties;
  assert.equal(typeof properties, "object");
  assert.notEqual(properties, null);
  return properties as Record<string, unknown>;
}

function defs(schema: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const value = schema.$defs;
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, Record<string, unknown>>;
}

test("trace schema freezes the minimum Trace shape", () => {
  const schema = load("trace.schema.json");
  assert.equal(schema.$id, "urn:mesa:agent-failure-lab:trace");
  assert.deepEqual(stringList(schema.required), [
    "trace_id",
    "agent_id",
    "run_id",
    "task_id",
    "started_at",
    "ended_at",
    "status",
    "steps",
    "outcome",
    "totals",
    "fault",
    "diagnosis",
  ]);

  const properties = objectProps(schema);
  assert.ok(properties.outcome);
  assert.ok(properties.diagnosis);
  assert.equal("phase" in properties, false);
  assert.equal("injection_plan_id" in properties, false);

  const nested = defs(schema);
  const step = nested.Step;
  assert.ok(step);
  const stepProps = objectProps(step);
  for (const field of [
    "step_id",
    "index",
    "type",
    "timestamp",
    "role",
    "content",
    "tool_name",
    "tool_call_id",
    "tool_input",
    "tool_output",
    "tool_error",
    "latency_ms",
    "token_usage",
    "cost_usd",
  ]) {
    assert.ok(stepProps[field], `missing step field ${field}`);
  }

  assert.deepEqual(nested.StepType?.enum, ["message", "tool_call", "tool_result", "system"]);
  assert.deepEqual(nested.FaultCategory?.enum, [
    "Plan",
    "ToolUse",
    "Context",
    "Reasoning",
    "Execution",
    "Verification",
    "Security",
  ]);

  const verifier = nested.VerifierOutcome;
  assert.ok(verifier);
  assert.deepEqual(stringList(verifier.required), ["passed", "checks", "mock_state_snapshot"]);

  const totals = nested.Totals;
  assert.ok(totals);
  assert.deepEqual(stringList(totals.required), ["latency_ms", "tokens", "cost_usd"]);

  const fault = nested.Fault;
  assert.ok(fault);
  assert.deepEqual(stringList(fault.required), ["injected", "labels", "attacker"]);

  const diagnosis = nested.Diagnosis;
  assert.ok(diagnosis);
  assert.deepEqual(stringList(diagnosis.required), [
    "category",
    "cause",
    "step_id",
    "confidence",
    "evidence",
    "proposed_fixes",
  ]);
});

test("agent schema freezes registration and verifier_checks tasks", () => {
  const schema = load("agent.schema.json");
  assert.equal(schema.$id, "urn:mesa:agent-failure-lab:agent");
  assert.deepEqual(stringList(schema.required), [
    "agent_id",
    "name",
    "created_at",
    "updated_at",
    "instance",
    "test_instance",
    "traces",
    "docs",
    "tasks",
  ]);

  const nested = defs(schema);
  assert.deepEqual(nested.InstanceKind?.enum, ["reference", "external"]);
  assert.equal(nested.SuccessTest?.properties && (objectProps(nested.SuccessTest).type as { const: string }).const, "verifier_checks");

  const task = nested.Task;
  assert.ok(task);
  assert.deepEqual(stringList(task.required), ["task_id", "title", "prompt", "success_test"]);

  const check = nested.VerifierCheckSpec;
  assert.ok(check);
  assert.deepEqual(stringList(check.required), ["check_id", "description", "assertion"]);
});

test("run schema stays outside Trace and carries harness phase metadata", () => {
  const schema = load("run.schema.json");
  assert.equal(schema.$id, "urn:mesa:agent-failure-lab:run");
  assert.deepEqual(stringList(schema.required), ["run_id", "phase", "trace_id"]);

  const properties = objectProps(schema);
  const phase = properties.phase as { enum: string[] };
  assert.deepEqual(phase.enum, ["baseline", "injected", "after_fix"]);
  assert.ok(properties.injection_plan_id);
  assert.ok(properties.fix_id);
  assert.ok(properties.fix_summary);
  assert.ok(properties.fix_applied_at);
  assert.equal("steps" in properties, false);
  assert.equal("outcome" in properties, false);
  assert.equal("diagnosis" in properties, false);
});
