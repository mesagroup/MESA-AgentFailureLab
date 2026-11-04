import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { permissionsFor, scriptedActions } from "../../backend/src/agent/scripted.js";
import { createHttpMockClient } from "../../backend/src/mock/client.js";
import { MemoryStore } from "../../backend/src/persistence/memory.js";
import { loadReferenceAgent } from "../../backend/src/reference-agent.js";
import { buildApp } from "../../../services/mock-shop/src/app.js";
import { LAB_TASK_IDS } from "../src/fixes/domain.js";
import { basePlan } from "../src/fixes/plan.js";
import { renderReplayMarkdown, runReplay } from "../src/replay/run.js";
import type { AttemptScore, TaskReplayRow } from "../src/replay/types.js";
import { createHarnessReplayPort, presetCategory, scoreScriptedBaseline } from "../scripts/harness-port.js";

describe("harness replay", () => {
  it("uses the same base plan as the backend scripted driver", () => {
    const agent = loadReferenceAgent();
    for (const taskId of LAB_TASK_IDS) {
      const task = agent.tasks.find((entry) => entry.task_id === taskId);
      assert.ok(task, taskId);
      const permissions = permissionsFor(task, true);
      const orderId = task.setup.orders.length > 0 ? "ord_0001" : undefined;
      assert.deepEqual(basePlan(taskId, { permissions, orderId }), scriptedActions(task, { permissions, orderId }));
    }
    const t5 = agent.tasks.find((entry) => entry.task_id === "T5");
    assert.ok(t5);
    assert.deepEqual(basePlan("T5", { permissions: permissionsFor(t5, false), orderId: "ord_0001" }), []);
  });

  it("compares injected before and after with the backend verifier", async () => {
    const shop = buildApp({ logger: false });
    const baseUrl = await shop.listen({ port: 0, host: "127.0.0.1" });
    try {
    const agent = loadReferenceAgent();
    const report = await runReplay({
      port: createHarnessReplayPort({
        agent,
        store: new MemoryStore(),
        mock: createHttpMockClient(baseUrl),
        mockBaseUrl: baseUrl,
      }),
      categoryFor: presetCategory,
    });

    const t1 = taskRow(report.tasks, "T1");
    assert.deepEqual(t1.fix_kinds, ["pre_response_check"]);
    assert.equal(t1.fix_source, "adr-002-category-map");
    assert.equal(t1.baseline.passed, true);
    assert.equal(t1.baseline_all_fixes.passed, true);
    assert.equal(t1.injected_before.passed, false);
    assert.equal(t1.injected_before.failed_checks.includes("product_viewed"), true);
    assert.equal(t1.fix_verified, true);
    assert.equal(t1.regression, false);
    assert.equal(t1.injected_after.status, "ran");
    if (t1.injected_after.status === "ran") {
      assert.equal(t1.injected_after.attempt.passed, true);
      assert.deepEqual(t1.injected_after.attempt.fix_kinds_on_run, ["pre_response_check"]);
      assert.equal(t1.injected_after.attempt.fix_kinds_on_agent_run_request, true);
      assert.equal(t1.injected_after.attempt.policy_applied_in_call_agent, true);
      assert.equal(t1.injected_after.attempt.parent_run_id, t1.injected_before.run_id);
    }

    for (const taskId of ["T2", "T3", "T4"] as const) {
      const row = taskRow(report.tasks, taskId);
      assert.equal(row.fix_source, "none");
      assert.deepEqual(row.fix_kinds, []);
      assert.equal(row.baseline.passed, true);
      assert.equal(row.baseline_all_fixes.passed, true);
      assert.equal(row.injected_before.passed, false);
      assert.equal(row.injected_after.status, "skipped");
      assert.equal(row.fix_verified, null);
      assert.equal(row.regression, false);
    }

    const t5 = taskRow(report.tasks, "T5");
    assert.deepEqual(t5.fix_kinds, ["permission_guard"]);
    assert.equal(t5.baseline.passed, true);
    assert.equal(t5.baseline_all_fixes.passed, true);
    assert.equal(t5.injected_before.passed, false);
    assert.equal(t5.injected_after.status, "ran");
    if (t5.injected_after.status === "ran") {
      assert.equal(t5.injected_after.attempt.passed, false);
      assert.equal(t5.injected_after.attempt.fix_kinds_on_agent_run_request, true);
    }
    assert.equal(t5.fix_verified, false);
    assert.equal(t5.regression, false);

    assert.equal(report.timing.latency_ms_equals_step_count, true);
    for (const row of report.tasks) {
      for (const attempt of armAttempts(row)) {
        assert.equal(attempt.source, "backend-harness");
        assert.equal(attempt.latency_ms, attempt.step_count);
        assert.equal(attempt.tokens_in, 0);
        assert.equal(attempt.tokens_out, 0);
        assert.equal(attempt.cost_usd, 0);
        assert.equal(attempt.fix_kinds_on_agent_run_request, attempt.fix_kinds_on_run.length > 0);
      }
    }

    const markdown = renderReplayMarkdown(report);
    assert.match(markdown, /\| T1 \| Verification \| pre_response_check \|/);
    assert.match(markdown, /Fix verified/);
    assert.match(markdown, /latency_ms equals step_count/);
    const committed = readFileSync(new URL("../replay/latest.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    // Preserve the historical report; only its decision wording predates #100.
    const historicalWording = "fix_verified is true only when injected_after passes the backend verifier and injected_before does not, and regression is false.";
    assert.equal(committed.replace(historicalWording, report.decision).startsWith(markdown), true);
    assert.match(committed, /T1: verifier pass/);
    assert.match(committed, /T5: verifier pass/);
    } finally {
      await shop.close();
    }
  });

  it("scores the scripted applicator on a clean shop with verifyOutcome", async () => {
    const shop = buildApp({ logger: false });
    const baseUrl = await shop.listen({ port: 0, host: "127.0.0.1" });
    try {
    const rows = await scoreScriptedBaseline({
      baseUrl,
      mock: createHttpMockClient(baseUrl),
      agent: loadReferenceAgent(),
    });
    assert.equal(rows.length, 5);
    for (const row of rows) {
      assert.equal(row.passed, true, `${row.task_id} failed ${row.failed_checks.join(", ")}`);
      assert.equal(row.claimed_success, true, row.task_id);
    }
    } finally {
      await shop.close();
    }
  });
});

function taskRow(rows: readonly TaskReplayRow[], taskId: TaskReplayRow["task_id"]): TaskReplayRow {
  const found = rows.find((row) => row.task_id === taskId);
  if (found === undefined) throw new Error(`Missing ${taskId}.`);
  return found;
}

function armAttempts(row: TaskReplayRow): AttemptScore[] {
  const attempts = [row.baseline, row.baseline_all_fixes, row.injected_before];
  if (row.injected_after.status === "ran") attempts.push(row.injected_after.attempt);
  return attempts;
}
